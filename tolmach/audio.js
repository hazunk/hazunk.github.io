// Browser audio: microphone capture, playback of translated speech, and the
// device voice for engines that return text.

import { int16ToFloat, catchUpRate, MAX_BACKLOG_SECONDS, speechRate, MAX_SPEECH_QUEUE_CHARS } from "./core.js";

const loadedContexts = new WeakSet();

export class MicCapture {
  /** @param {(samples: Float32Array, sampleRate: number) => void} onSamples */
  constructor(ctx, { deviceId, onSamples }) {
    this.ctx = ctx;
    this.deviceId = deviceId;
    this.onSamples = onSamples;
    this.stream = null;
  }

  async start() {
    // Safari: ask for a play-and-record session so headphones keep playing while the mic is open.
    try {
      if (navigator.audioSession) navigator.audioSession.type = "play-and-record";
    } catch {}

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: this.deviceId ? { exact: this.deviceId } : undefined,
        channelCount: 1,
        // Keeps our own voice output from being re-translated if audio leaks out of a speaker.
        echoCancellation: true,
        // The services do their own noise handling; the browser's tends to swallow distant voices.
        noiseSuppression: false,
        autoGainControl: true,
      },
    });

    if (!loadedContexts.has(this.ctx)) {
      await this.ctx.audioWorklet.addModule(new URL("./capture-worklet.js", import.meta.url));
      loadedContexts.add(this.ctx);
    }
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, "tolmach-capture");
    this.node.port.onmessage = (event) => this.onSamples(event.data, this.ctx.sampleRate);
    // The worklet only runs while connected to the output; a muted gain keeps it silent.
    this.sink = this.ctx.createGain();
    this.sink.gain.value = 0;
    this.source.connect(this.node).connect(this.sink).connect(this.ctx.destination);
  }

  get isLive() {
    return this.stream?.getAudioTracks().some((track) => track.readyState === "live") ?? false;
  }

  get label() {
    return this.stream?.getAudioTracks()[0]?.label || "Microphone";
  }

  stop() {
    this.node?.port.close();
    for (const node of [this.source, this.node, this.sink]) {
      try {
        node?.disconnect();
      } catch {}
    }
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
  }
}

/** Plays 16-bit PCM chunks back to back, speeding up a little when they queue up. */
export class PcmPlayer {
  constructor(ctx, { onBacklog } = {}) {
    this.ctx = ctx;
    this.onBacklog = onBacklog;
    this.output = ctx.createGain();
    this.output.connect(ctx.destination);
    this.sources = new Set();
    this.nextTime = 0;
    this.catchUp = true;
    this.playedChunks = 0;
  }

  get backlogSeconds() {
    return Math.max(0, this.nextTime - this.ctx.currentTime);
  }

  enqueue(int16, sampleRate) {
    if (!int16.length) return;
    if (this.catchUp && this.backlogSeconds > MAX_BACKLOG_SECONDS) this.skipToLive();

    const buffer = this.ctx.createBuffer(1, int16.length, sampleRate);
    buffer.copyToChannel(int16ToFloat(int16), 0);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    const rate = catchUpRate(this.backlogSeconds, this.catchUp);
    source.playbackRate.value = rate;
    source.connect(this.output);

    const startAt = Math.max(this.ctx.currentTime + 0.03, this.nextTime);
    source.start(startAt);
    this.nextTime = startAt + buffer.duration / rate;
    this.sources.add(source);
    this.playedChunks++;
    source.onended = () => {
      this.sources.delete(source);
      this.report();
    };
    this.report();
  }

  skipToLive() {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {}
    }
    this.sources.clear();
    this.nextTime = 0;
    this.report();
  }

  report() {
    this.onBacklog?.(this.backlogSeconds);
  }
}

/** Reads translated text aloud with the device's own voices (free, works offline). */
export class Speaker {
  constructor({ voiceURI, onBacklog } = {}) {
    this.voiceURI = voiceURI;
    this.onBacklog = onBacklog;
    this.catchUp = true;
    this.pendingChars = 0;
    this.live = new Set(); // keeps utterances referenced until they finish (Chrome drops events otherwise)
    this.spokenCount = 0;
  }

  static get supported() {
    return typeof speechSynthesis !== "undefined";
  }

  static englishVoices() {
    if (!Speaker.supported) return [];
    return speechSynthesis
      .getVoices()
      .filter((voice) => /^en[-_]/i.test(voice.lang))
      .sort((a, b) => Speaker.score(b) - Speaker.score(a));
  }

  /** Prefers the higher-quality voices iOS and macOS can download. */
  static score(voice) {
    let score = 0;
    if (/premium/i.test(voice.name)) score += 4;
    if (/enhanced|natural|neural/i.test(voice.name)) score += 3;
    if (voice.localService) score += 1;
    if (/^en[-_](GB|US)/i.test(voice.lang)) score += 1;
    return score;
  }

  /** Must run inside a tap: iOS only lets pages speak after a user gesture. */
  unlock() {
    if (!Speaker.supported) return;
    speechSynthesis.cancel();
    const silent = new SpeechSynthesisUtterance(" ");
    silent.volume = 0;
    speechSynthesis.speak(silent);
  }

  say(text) {
    if (!Speaker.supported || !text) return;
    if (this.catchUp && this.pendingChars > MAX_SPEECH_QUEUE_CHARS) this.skipToLive();

    const utterance = new SpeechSynthesisUtterance(text);
    const voice = Speaker.englishVoices().find((v) => v.voiceURI === this.voiceURI) ?? Speaker.englishVoices()[0];
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    } else {
      utterance.lang = "en-US";
    }
    utterance.rate = speechRate(this.pendingChars + text.length, this.catchUp);
    this.pendingChars += text.length;
    this.live.add(utterance);
    const done = () => {
      if (!this.live.delete(utterance)) return;
      this.pendingChars = Math.max(0, this.pendingChars - text.length);
      this.report();
    };
    utterance.onend = done;
    utterance.onerror = done;
    speechSynthesis.speak(utterance);
    this.spokenCount++;
    this.report();
  }

  skipToLive() {
    if (!Speaker.supported) return;
    this.live.clear();
    this.pendingChars = 0;
    speechSynthesis.cancel();
    this.report();
  }

  report() {
    // Roughly 15 characters per second of speech.
    this.onBacklog?.(this.pendingChars / 15);
  }
}
