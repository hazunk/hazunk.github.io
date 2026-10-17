// Connections to the translation services. Each engine takes 16-bit PCM from the
// microphone and reports back through callbacks:
//
//   onReady()                        connected; audio can flow
//   onAudio(int16, sampleRate)       translated speech (speech-to-speech engines)
//   onSource(text, speaker, untranslated)  original-language transcript fragment
//   onTranslation(text, speaker)     translated transcript fragment
//   onInterim({source, translation}) not-yet-final text (Soniox)
//   onPause()                        the speaker stopped (Soniox endpoint)
//   onNotice(message)                non-fatal server message
//   onClose({fatal, message, renew}) connection ended without close() being called;
//                                    renew = the server asked for a fresh session

import {
  ENGINES,
  GEMINI_URL,
  OPENAI_URL,
  SONIOX_URL,
  geminiSetup,
  geminiAudio,
  parseGemini,
  openaiSessionUpdate,
  openaiAudio,
  parseOpenAI,
  sonioxConfig,
  parseSoniox,
  base64ToInt16,
  int16ToBytes,
  isFatalError,
} from "./core.js";

class Engine {
  constructor(spec, options) {
    this.spec = spec;
    this.options = options;
    this.callbacks = options.callbacks;
    this.inputRate = spec.inputRate;
    this.ws = null;
    this.ready = false;
    this.opened = false;
    this.done = false;
  }

  get speaksItself() {
    return this.spec.voice === "natural";
  }

  url(defaultUrl) {
    return this.options.endpoint ? `${this.options.endpoint}/${this.spec.id}` : defaultUrl;
  }

  open(url, protocols) {
    const ws = protocols ? new WebSocket(url, protocols) : new WebSocket(url);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      this.opened = true;
      this.onOpen();
    };
    ws.onmessage = (event) => {
      const text = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        return;
      }
      this.onMessage(message);
    };
    ws.onclose = (event) => this.finish(event.code, event.reason);
    this.ws = ws;
  }

  markReady() {
    if (this.ready) return;
    this.ready = true;
    this.callbacks.onReady?.();
  }

  send(data) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(data);
  }

  /** Ends the session on purpose. No onClose follows. */
  close() {
    if (this.done) return;
    this.done = true;
    try {
      this.ws?.close(1000);
    } catch {}
  }

  /** `renew` marks a planned hand-over to a fresh session rather than a failure. */
  finish(code, reason, fatalOverride, renew = false) {
    if (this.done) return;
    this.done = true;
    try {
      this.ws?.close();
    } catch {}
    const message = reason || this.describeClose(code);
    const fatal = fatalOverride ?? isFatalError(reason, code);
    this.callbacks.onClose?.({ fatal, message, code, renew });
  }

  describeClose(code) {
    if (!this.opened) return `Couldn't connect to ${this.spec.vendor}. Check your internet connection and API key.`;
    return `${this.spec.vendor} closed the connection (${code}).`;
  }
}

// Google Gemini Live Translate: speech in, translated speech out.
class GeminiEngine extends Engine {
  connect() {
    this.open(`${this.url(GEMINI_URL)}?key=${encodeURIComponent(this.options.apiKey)}`);
  }

  onOpen() {
    this.send(JSON.stringify(geminiSetup({ targetLanguage: this.options.targetLanguage })));
  }

  onMessage(message) {
    const result = parseGemini(message);
    if (result.ready) this.markReady();
    for (const chunk of result.audio) this.callbacks.onAudio?.(base64ToInt16(chunk.data), chunk.sampleRate);
    if (result.sourceText) this.callbacks.onSource?.(result.sourceText, null, false);
    if (result.translationText) this.callbacks.onTranslation?.(result.translationText, null);
    if (result.error) this.callbacks.onNotice?.(`Gemini: ${result.error}`);
    // The server is about to end this connection (they last ~10 minutes): reconnect now.
    if (result.goAway) this.finish(1000, "Renewing the Gemini session…", false, true);
  }

  sendAudio(int16) {
    if (this.ready) this.send(JSON.stringify(geminiAudio(int16, this.inputRate)));
  }
}

// OpenAI realtime translation: speech in, translated speech out.
class OpenAIEngine extends Engine {
  connect() {
    // Browsers can't set an Authorization header on a WebSocket; OpenAI accepts the key as a subprotocol.
    this.open(`${this.url(OPENAI_URL)}?model=${ENGINES.openai.model}`, [
      "realtime",
      `openai-insecure-api-key.${this.options.apiKey}`,
    ]);
  }

  onOpen() {
    this.send(JSON.stringify(openaiSessionUpdate({ targetLanguage: this.options.targetLanguage })));
    this.markReady();
  }

  onMessage(message) {
    const result = parseOpenAI(message);
    if (result.ready) this.markReady();
    for (const chunk of result.audio) this.callbacks.onAudio?.(base64ToInt16(chunk.data), chunk.sampleRate);
    if (result.sourceText) this.callbacks.onSource?.(result.sourceText, null, false);
    if (result.translationText) this.callbacks.onTranslation?.(result.translationText, null);
    if (result.error) {
      if (isFatalError(result.error)) this.finish(4000, `OpenAI: ${result.error}`, true);
      else this.callbacks.onNotice?.(`OpenAI: ${result.error}`);
    }
  }

  sendAudio(int16) {
    if (this.ready) this.send(JSON.stringify(openaiAudio(int16)));
  }

  close() {
    if (!this.done) this.send(JSON.stringify({ type: "session.close" }));
    super.close();
  }
}

// Soniox: speech in, original + translated text out. The device reads the translation aloud.
class SonioxEngine extends Engine {
  connect() {
    this.open(this.url(SONIOX_URL));
  }

  onOpen() {
    this.send(
      JSON.stringify(
        sonioxConfig({ apiKey: this.options.apiKey, targetLanguage: this.options.targetLanguage, sampleRate: this.inputRate }),
      ),
    );
    this.markReady();
  }

  onMessage(message) {
    const result = parseSoniox(message);
    if (result.error) {
      this.finish(result.error.code, `Soniox: ${result.error.message}`, isFatalError(result.error.message, result.error.code));
      return;
    }
    for (const piece of result.final) {
      if (piece.kind === "translation") this.callbacks.onTranslation?.(piece.text, piece.speaker);
      else this.callbacks.onSource?.(piece.text, piece.speaker, piece.untranslated);
    }
    this.callbacks.onInterim?.({ source: result.interimSource, translation: result.interimTranslation });
    if (result.endpoint) this.callbacks.onPause?.();
    if (result.finished) this.finish(1000, "Soniox ended the session.", false);
  }

  sendAudio(int16) {
    if (this.ready) this.send(int16ToBytes(int16));
  }

  close() {
    // An empty frame tells Soniox the audio has ended.
    if (!this.done) this.send("");
    super.close();
  }
}

const CLASSES = { gemini: GeminiEngine, openai: OpenAIEngine, soniox: SonioxEngine };

export function createEngine(id, options) {
  const Class = CLASSES[id];
  if (!Class) throw new Error(`Unknown engine: ${id}`);
  return new Class(ENGINES[id], options);
}
