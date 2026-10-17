// Pure logic for the Tolmach web app: no DOM, no network. Unit tested with `node --test`.

// ---------------------------------------------------------------------------
// Engines: the translation services the app can use.
// Prices are per minute of audio, taken from each provider's published rates
// (Oct 2026). They only feed the on-screen estimate.

export const ENGINES = {
  gemini: {
    id: "gemini",
    name: "Gemini Live Translate",
    vendor: "Google",
    model: "gemini-3.5-live-translate-preview",
    inputRate: 16000,
    voice: "natural",
    // $3.50 / 1M audio input tokens, $21 / 1M audio output tokens, 25 tokens per second.
    dollarsPerInputMinute: 0.00525,
    dollarsPerOutputMinute: 0.0315,
    priceLabel: "Free tier, or ~$1–2/hr",
    keyUrl: "https://aistudio.google.com/apikey",
  },
  soniox: {
    id: "soniox",
    name: "Soniox",
    vendor: "Soniox",
    model: "stt-rt-v5",
    inputRate: 16000,
    voice: "device",
    // ~$0.18 per hour for real-time transcription + translation.
    dollarsPerInputMinute: 0.003,
    dollarsPerOutputMinute: 0,
    priceLabel: "~$0.18/hr",
    keyUrl: "https://console.soniox.com",
  },
  openai: {
    id: "openai",
    name: "OpenAI Realtime Translate",
    vendor: "OpenAI",
    model: "gpt-realtime-translate",
    inputRate: 24000,
    voice: "natural",
    dollarsPerInputMinute: 0.034,
    dollarsPerOutputMinute: 0,
    priceLabel: "~$2/hr",
    keyUrl: "https://platform.openai.com/api-keys",
  },
};

export function estimateCost(engineId, { listenSeconds = 0, outputSeconds = 0 } = {}) {
  const engine = ENGINES[engineId];
  if (!engine) return 0;
  return (listenSeconds / 60) * engine.dollarsPerInputMinute + (outputSeconds / 60) * engine.dollarsPerOutputMinute;
}

// ---------------------------------------------------------------------------
// PCM helpers. All network audio is 16-bit little-endian mono PCM.

export function floatToInt16(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
  }
  return out;
}

export function int16ToFloat(int16) {
  const out = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) out[i] = int16[i] / 32768;
  return out;
}

/** Little-endian bytes of an Int16Array, regardless of platform endianness. */
export function int16ToBytes(int16) {
  const bytes = new Uint8Array(int16.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < int16.length; i++) view.setInt16(i * 2, int16[i], true);
  return bytes;
}

export function bytesToInt16(bytes) {
  const count = Math.floor(bytes.length / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, count * 2);
  const out = new Int16Array(count);
  for (let i = 0; i < count; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}

export function bytesToBase64(bytes) {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

export function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export const int16ToBase64 = (int16) => bytesToBase64(int16ToBytes(int16));
export const base64ToInt16 = (base64) => bytesToInt16(base64ToBytes(base64));

/**
 * Streaming sample-rate converter for speech. Averages over the decimation
 * window (a cheap low-pass) and interpolates linearly, carrying state across
 * calls so chunk boundaries don't click.
 */
export class Resampler {
  constructor(inRate, outRate) {
    this.inRate = inRate;
    this.outRate = outRate;
    this.step = inRate / outRate;
    this.window = Math.max(1, Math.floor(this.step));
    this.position = 0; // read position into `history + input`, in input samples
    this.history = new Float32Array(0);
  }

  process(input) {
    if (this.inRate === this.outRate) return Float32Array.from(input);
    const data = new Float32Array(this.history.length + input.length);
    data.set(this.history);
    data.set(input, this.history.length);

    const out = [];
    let pos = this.position;
    while (pos + this.window < data.length) {
      const i = Math.floor(pos);
      const frac = pos - i;
      out.push(this.average(data, i) * (1 - frac) + this.average(data, i + 1) * frac);
      pos += this.step;
    }
    const keepFrom = Math.max(0, Math.floor(pos) - this.window);
    this.history = data.slice(keepFrom);
    this.position = pos - keepFrom;
    return Float32Array.from(out);
  }

  average(data, start) {
    let sum = 0;
    const end = Math.min(data.length, start + this.window);
    for (let j = start; j < end; j++) sum += data[j];
    return sum / Math.max(1, end - start);
  }
}

/** Collects samples into fixed-size Int16 chunks. */
export class ChunkAccumulator {
  constructor(chunkSamples) {
    this.chunkSamples = chunkSamples;
    this.pending = new Int16Array(0);
  }

  push(samples) {
    const merged = new Int16Array(this.pending.length + samples.length);
    merged.set(this.pending);
    merged.set(samples, this.pending.length);
    const chunks = [];
    let offset = 0;
    while (merged.length - offset >= this.chunkSamples) {
      chunks.push(merged.slice(offset, offset + this.chunkSamples));
      offset += this.chunkSamples;
    }
    this.pending = merged.slice(offset);
    return chunks;
  }

  reset() {
    this.pending = new Int16Array(0);
  }
}

export function rms(int16) {
  if (!int16.length) return 0;
  let sum = 0;
  for (let i = 0; i < int16.length; i++) {
    const s = int16[i] / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / int16.length);
}

/** Maps an RMS level onto 0...1 for a meter, covering -50 dBFS to 0 dBFS. */
export function meterLevel(level) {
  if (level <= 0) return 0;
  const db = 20 * Math.log10(level);
  return Math.min(1, Math.max(0, (db + 50) / 50));
}

// ---------------------------------------------------------------------------
// Pacing: keep the voice in your ear close to live.

/** Playback rate for queued speech. Web Audio raises pitch with speed, so stay gentle. */
export function catchUpRate(backlogSeconds, enabled = true) {
  if (!enabled) return 1;
  if (backlogSeconds < 2) return 1;
  if (backlogSeconds < 5) return 1.06;
  return 1.12;
}

/** Above this much queued speech, drop the queue and jump to the latest. */
export const MAX_BACKLOG_SECONDS = 10;

/** Speech-synthesis rate (pitch preserved) for the amount of text still waiting to be spoken. */
export function speechRate(queuedChars, enabled = true) {
  if (!enabled) return 1;
  if (queuedChars < 120) return 1;
  if (queuedChars < 260) return 1.2;
  return 1.4;
}

export const MAX_SPEECH_QUEUE_CHARS = 450;

// ---------------------------------------------------------------------------
// Transcript: groups the original and translated text streams into segments.

export class TranscriptBuilder {
  constructor({ pauseMs = 1600, maxSegmentMs = 25000, maxSegments = 300 } = {}) {
    this.pauseMs = pauseMs;
    this.maxSegmentMs = maxSegmentMs;
    this.maxSegments = maxSegments;
    this.segments = [];
    this.lastFragmentAt = null;
    this.nextId = 0;
  }

  appendSource(text, now, speaker) {
    this.append("source", text, now, speaker);
  }

  /** `spokenInTarget`: the text was said in the target language, so it starts a turn like original speech does. */
  appendTranslation(text, now, speaker, spokenInTarget = false) {
    this.append("translation", text, now, speaker, spokenInTarget);
  }

  reset() {
    this.segments = [];
    this.lastFragmentAt = null;
  }

  append(field, text, now, speaker, startsTurn = field === "source") {
    if (!text) return;
    // A translation that trails into the next speaker's turn goes back to its own speaker's segment.
    if (!startsTurn && speaker != null && this.lastFragmentAt != null && now - this.lastFragmentAt <= this.pauseMs) {
      const recent = this.segments.slice(-3).reverse();
      const own = recent.find((segment) => segment.speaker === speaker);
      if (own && own !== this.segments[this.segments.length - 1]) {
        this.lastFragmentAt = now;
        own.translation = own.translation ? own.translation + text : text.trimStart();
        return;
      }
    }
    if (this.needsNewSegment(field, text, now, speaker, startsTurn)) this.startSegment(now, speaker);
    this.lastFragmentAt = now;
    const segment = this.segments[this.segments.length - 1];
    if (speaker != null && segment.speaker == null) segment.speaker = speaker;
    segment[field] = segment[field] ? segment[field] + text : text.trimStart();
  }

  needsNewSegment(field, text, now, speaker, startsTurn) {
    const current = this.segments[this.segments.length - 1];
    if (!current || this.lastFragmentAt == null) return true;
    if (now - this.lastFragmentAt > this.pauseMs) return true;
    // A different person started talking. Only original speech decides this:
    // a translation can trail behind into the next speaker's turn.
    if (startsTurn && speaker != null && current.speaker != null && speaker !== current.speaker) return true;
    if (now - current.startedAt <= this.maxSegmentMs) return false;
    const endsSentence = /[.?!…]$/.test(current[field]);
    return endsSentence && /^\s/.test(text);
  }

  startSegment(now, speaker) {
    this.segments.push({ id: this.nextId++, startedAt: now, source: "", translation: "", speaker: speaker ?? null });
    if (this.segments.length > this.maxSegments) {
      this.segments.splice(0, this.segments.length - this.maxSegments);
    }
  }
}

// ---------------------------------------------------------------------------
// English detection: Russian is Cyrillic, English is Latin.

export class EnglishTracker {
  constructor({ windowSize = 24, minimumLetters = 8, threshold = 0.8 } = {}) {
    this.windowSize = windowSize;
    this.minimumLetters = minimumLetters;
    this.threshold = threshold;
    this.recent = []; // true = Latin, false = Cyrillic
  }

  append(text) {
    for (const ch of text) {
      if (/\p{Script=Cyrillic}/u.test(ch)) this.recent.push(false);
      else if (/\p{Script=Latin}/u.test(ch) && /\p{L}/u.test(ch)) this.recent.push(true);
    }
    if (this.recent.length > this.windowSize) this.recent.splice(0, this.recent.length - this.windowSize);
  }

  reset() {
    this.recent = [];
  }

  get isLikelyEnglish() {
    if (this.recent.length < this.minimumLetters) return false;
    const share = (list) => list.filter(Boolean).length / list.length;
    return share(this.recent) >= this.threshold && share(this.recent.slice(-this.minimumLetters)) >= this.threshold;
  }
}

// ---------------------------------------------------------------------------
// Sentence chunking for engines whose translation is read aloud by the device.

export class SentenceChunker {
  constructor({ maxChars = 220 } = {}) {
    this.maxChars = maxChars;
    this.buffer = "";
  }

  /** Adds text; returns any complete sentences ready to speak. */
  push(text) {
    this.buffer += text;
    const ready = [];
    const boundary = /[.?!…]+["»”')\]]*(?=\s|$)/g;
    let cut = 0;
    let match;
    while ((match = boundary.exec(this.buffer))) {
      const end = match.index + match[0].length;
      // Keep "3.5" and initials like "A." together with what follows.
      if (/\d$/.test(this.buffer.slice(0, match.index)) && match[0] === "." && end === this.buffer.length) continue;
      const sentence = this.buffer.slice(cut, end).trim();
      if (sentence) ready.push(sentence);
      cut = end;
    }
    this.buffer = this.buffer.slice(cut);
    if (this.buffer.length > this.maxChars) {
      const lastSpace = this.buffer.lastIndexOf(" ", this.maxChars);
      const at = lastSpace > 40 ? lastSpace : this.buffer.length;
      const piece = this.buffer.slice(0, at).trim();
      if (piece) ready.push(piece);
      this.buffer = this.buffer.slice(at);
    }
    return ready;
  }

  /** Returns whatever is left (e.g. when the speaker paused). */
  flush() {
    const rest = this.buffer.trim();
    this.buffer = "";
    return rest || null;
  }

  get pendingText() {
    return this.buffer;
  }
}

// ---------------------------------------------------------------------------
// Gemini Live API (Live Translate).
// https://ai.google.dev/gemini-api/docs/live-api/live-translate

export const GEMINI_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

export function geminiSetup({ model = ENGINES.gemini.model, targetLanguage = "en", echoTargetLanguage = false } = {}) {
  return {
    setup: {
      model: `models/${model}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        translationConfig: { targetLanguageCode: targetLanguage, echoTargetLanguage },
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
  };
}

export function geminiAudio(int16, sampleRate = 16000) {
  return { realtimeInput: { audio: { data: int16ToBase64(int16), mimeType: `audio/pcm;rate=${sampleRate}` } } };
}

/** Reduces a Live API server message to what the app uses. */
export function parseGemini(message) {
  const result = { ready: false, audio: [], sourceText: "", translationText: "", goAway: false, interrupted: false, error: null };
  if (!message || typeof message !== "object") return result;
  if (message.setupComplete) result.ready = true;
  if (message.goAway) result.goAway = true;
  if (message.error) result.error = message.error.message || JSON.stringify(message.error);
  const content = message.serverContent;
  if (content) {
    for (const part of content.modelTurn?.parts ?? []) {
      const inline = part.inlineData;
      if (inline?.data && (!inline.mimeType || inline.mimeType.startsWith("audio/"))) {
        const rate = Number(/rate=(\d+)/.exec(inline.mimeType ?? "")?.[1] ?? 24000);
        result.audio.push({ data: inline.data, sampleRate: rate });
      }
    }
    result.sourceText = content.inputTranscription?.text ?? "";
    result.translationText = content.outputTranscription?.text ?? "";
    result.interrupted = content.interrupted === true;
  }
  return result;
}

// ---------------------------------------------------------------------------
// OpenAI realtime translation.
// https://developers.openai.com/api/docs/guides/realtime-translation

export const OPENAI_URL = "wss://api.openai.com/v1/realtime/translations";

export function openaiSessionUpdate({ targetLanguage = "en", noiseReduction = "far_field", transcribeSource = true } = {}) {
  const input = { noise_reduction: noiseReduction ? { type: noiseReduction } : null };
  if (transcribeSource) input.transcription = { model: "gpt-realtime-whisper" };
  return { type: "session.update", session: { audio: { input, output: { language: targetLanguage } } } };
}

export function openaiAudio(int16) {
  return { type: "session.input_audio_buffer.append", audio: int16ToBase64(int16) };
}

export function parseOpenAI(event) {
  const result = { ready: false, audio: [], sourceText: "", translationText: "", closed: false, error: null };
  const type = event?.type;
  if (typeof type !== "string") return result;
  if (type === "session.created" || type === "session.updated") result.ready = true;
  else if (type === "session.closed") result.closed = true;
  else if (type === "error") result.error = event.error?.message || event.error?.code || "Unknown error";
  else if (type.endsWith("output_audio.delta") && event.delta) result.audio.push({ data: event.delta, sampleRate: 24000 });
  else if (type.endsWith("output_transcript.delta") || type.endsWith("output_audio_transcript.delta")) result.translationText = event.delta ?? "";
  else if (type.endsWith("input_transcript.delta") || type.endsWith("input_audio_transcription.delta")) result.sourceText = event.delta ?? "";
  return result;
}

// ---------------------------------------------------------------------------
// Soniox real-time transcription + translation.
// https://soniox.com/docs/stt/rt/real-time-translation

export const SONIOX_URL = "wss://stt-rt.soniox.com/transcribe-websocket";

export function sonioxConfig({ apiKey, model = ENGINES.soniox.model, targetLanguage = "en", sampleRate = 16000 } = {}) {
  return {
    api_key: apiKey,
    model,
    audio_format: "pcm_s16le",
    sample_rate: sampleRate,
    num_channels: 1,
    language_hints: ["ru", targetLanguage],
    enable_language_identification: true,
    enable_speaker_diarization: true,
    enable_endpoint_detection: true,
    translation: { type: "one_way", target_language: targetLanguage },
  };
}

/**
 * Turns Soniox responses into transcript events. Final tokens arrive once and are
 * emitted as appendable text; non-final tokens are replaced on every response and
 * are returned as the current interim text.
 */
export function parseSoniox(response) {
  const result = { final: [], interimSource: "", interimTranslation: "", endpoint: false, finished: false, error: null };
  if (!response || typeof response !== "object") return result;
  if (response.error_code) {
    result.error = { code: response.error_code, message: response.error_message || `Error ${response.error_code}` };
    return result;
  }
  result.finished = response.finished === true;
  for (const token of response.tokens ?? []) {
    const text = token.text ?? "";
    if (!text) continue;
    if (/^<\w+>$/.test(text)) {
      if (text === "<end>" && token.is_final) result.endpoint = true;
      continue;
    }
    const kind = token.translation_status === "translation" ? "translation" : "source";
    // Speech already in the target language comes back untranslated ("none"): show it, never speak it.
    if (token.is_final) {
      const last = result.final[result.final.length - 1];
      const speaker = token.speaker ?? null;
      const untranslated = token.translation_status === "none";
      if (last && last.kind === kind && last.speaker === speaker && last.untranslated === untranslated) last.text += text;
      else result.final.push({ kind, text, speaker, untranslated });
    } else if (kind === "translation") {
      result.interimTranslation += text;
    } else {
      result.interimSource += text;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Connection errors: which ones are worth retrying.

const FATAL_HINTS = [
  "api key",
  "api_key",
  "unauthorized",
  "permission",
  "invalid",
  "not found",
  "not supported",
  "quota",
  "billing",
  "insufficient",
  "payment",
  "exhausted",
];

export function isFatalError(message = "", code) {
  if (code === 1007 || code === 1008) return true;
  if (typeof code === "number" && code >= 400 && code < 500 && code !== 408 && code !== 429) return true;
  const lowered = String(message).toLowerCase();
  return FATAL_HINTS.some((hint) => lowered.includes(hint));
}
