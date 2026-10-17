// Tolmach web app: microphone → translation service → your headphones, plus a live transcript.

import {
  ENGINES,
  estimateCost,
  Resampler,
  ChunkAccumulator,
  floatToInt16,
  rms,
  meterLevel,
  TranscriptBuilder,
  EnglishTracker,
  SentenceChunker,
} from "./core.js";
import { createEngine } from "./engines.js";
import { MicCapture, PcmPlayer, Speaker } from "./audio.js";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
// For local testing against mock servers only, e.g. ?endpoint=ws://localhost:8787
const ENDPOINT_OVERRIDE = params.get("endpoint");

// ---------------------------------------------------------------------------
// Settings (kept in this browser only)

const SETTINGS_KEY = "tolmach.settings.v1";
const DEFAULTS = {
  engine: "gemini",
  keys: { gemini: "", soniox: "", openai: "" },
  micId: "",
  voiceURI: "",
  catchUp: true,
  skipEnglish: true,
  showSource: true,
  autoStopMinutes: 15,
};

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    return { ...DEFAULTS, ...saved, keys: { ...DEFAULTS.keys, ...(saved.keys || {}) } };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {}
}

const settings = loadSettings();

// ---------------------------------------------------------------------------
// Session state

const MAX_RECONNECTS = 6;
const PREROLL_CHUNKS = 30; // 3 s of audio kept while (re)connecting

const state = {
  phase: "idle", // idle | starting | live | reconnecting | failed
  error: null,
  notice: null,
  muted: false,
  backlog: 0,
  listenSeconds: 0,
  outputSeconds: 0,
  interim: { source: "", translation: "" },
};

let ctx = null;
let mic = null;
let player = null;
let speaker = null;
let engine = null;
let resampler = null;
let accumulator = null;
let preroll = [];
let transcript = new TranscriptBuilder();
let english = new EnglishTracker();
let chunker = new SentenceChunker();
let chunkerTimer = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
let connectedAt = 0;
let lastSpeechAt = 0;
let ticker = null;
let wakeLock = null;

// Counters for automated tests; harmless in normal use.
const debug = (window.tolmachDebug = { sentChunks: 0, sentSamples: 0, playedChunks: 0, spoken: [] });

const isRunning = () => ["starting", "live", "reconnecting"].includes(state.phase);

// ---------------------------------------------------------------------------
// Start / stop

async function start() {
  if (isRunning()) return;
  const spec = ENGINES[settings.engine];
  const apiKey = settings.keys[settings.engine]?.trim();
  if (!apiKey && !ENDPOINT_OVERRIDE) {
    state.notice = `Add your ${spec.vendor} API key to use ${spec.name}.`;
    render();
    openSettings(`key-${settings.engine}`);
    return;
  }

  // Audio must be unlocked inside the tap, before any await (iOS).
  ctx ??= new AudioContext({ latencyHint: "interactive" });
  ctx.resume();
  speaker ??= new Speaker({ onBacklog: setBacklog });
  if (spec.voice === "device") speaker.unlock();

  Object.assign(state, { phase: "starting", error: null, notice: null, muted: false, backlog: 0, listenSeconds: 0, outputSeconds: 0 });
  state.interim = { source: "", translation: "" };
  transcript.reset();
  english.reset();
  chunker = new SentenceChunker();
  reconnectAttempts = 0;
  lastSpeechAt = Date.now();
  render();

  try {
    mic = new MicCapture(ctx, { deviceId: settings.micId, onSamples });
    await mic.start();
  } catch (error) {
    fail(micErrorMessage(error));
    return;
  }
  if (state.phase !== "starting") {
    mic.stop();
    return;
  }

  player ??= new PcmPlayer(ctx, { onBacklog: setBacklog });
  player.catchUp = settings.catchUp;
  speaker.catchUp = settings.catchUp;
  speaker.voiceURI = settings.voiceURI;
  resampler = new Resampler(ctx.sampleRate, spec.inputRate);
  accumulator = new ChunkAccumulator(spec.inputRate / 10);
  preroll = [];

  keepAwake();
  ticker = setInterval(tick, 1000);
  connect();
}

function stop(notice = null) {
  if (state.phase === "idle") return;
  tearDown();
  state.phase = "idle";
  state.notice = notice;
  render();
}

function fail(message) {
  tearDown();
  state.phase = "failed";
  state.error = message;
  render();
}

function tearDown() {
  clearTimeout(reconnectTimer);
  clearTimeout(chunkerTimer);
  clearInterval(ticker);
  engine?.close();
  engine = null;
  mic?.stop();
  mic = null;
  player?.skipToLive();
  speaker?.skipToLive();
  wakeLock?.release().catch(() => {});
  wakeLock = null;
  state.backlog = 0;
  state.interim = { source: "", translation: "" };
  setMeter(0);
}

function micErrorMessage(error) {
  if (error?.name === "NotAllowedError") return "Microphone access is blocked. Allow it for this site in your browser settings, then try again.";
  if (error?.name === "NotFoundError" || error?.name === "OverconstrainedError") return "That microphone isn't available. Pick another one in Settings.";
  return `Couldn't start the microphone: ${error?.message || error}`;
}

// ---------------------------------------------------------------------------
// Connection

function connect() {
  const spec = ENGINES[settings.engine];
  const current = createEngine(spec.id, {
    apiKey: settings.keys[spec.id]?.trim(),
    targetLanguage: "en",
    endpoint: ENDPOINT_OVERRIDE,
    callbacks: {
      onReady: () => {
        if (engine !== current) return;
        connectedAt = Date.now();
        state.phase = "live";
        for (const chunk of preroll) send(chunk);
        preroll = [];
        render();
      },
      onAudio: (samples, sampleRate) => engine === current && playAudio(samples, sampleRate),
      onSource: (text, speakerId, untranslated) => engine === current && addSource(text, speakerId, untranslated),
      onTranslation: (text, speakerId) => engine === current && addTranslation(text, speakerId),
      onInterim: (interim) => {
        if (engine !== current) return;
        state.interim = interim;
        renderInterim();
      },
      onPause: () => engine === current && speakPending(),
      onNotice: (message) => {
        if (engine !== current) return;
        state.notice = message;
        renderBanner();
      },
      onClose: (info) => engine === current && connectionLost(info),
    },
  });
  engine = current;
  current.connect();
}

function connectionLost({ fatal, message, renew }) {
  engine = null;
  if (!isRunning()) return;
  if (fatal) {
    fail(message);
    return;
  }
  if (renew) {
    // Planned hand-over: audio is buffered meanwhile, so reconnect straight away.
    connectedAt = 0;
    connect();
    return;
  }
  // A connection that held for a while resets the retry budget (Gemini renews every ~10 minutes).
  if (connectedAt && Date.now() - connectedAt > 30000) reconnectAttempts = 0;
  connectedAt = 0;
  reconnectAttempts++;
  if (reconnectAttempts > MAX_RECONNECTS) {
    fail(message);
    return;
  }
  state.phase = "reconnecting";
  render();
  const delay = reconnectAttempts === 1 ? 0 : Math.min(8000, 1000 * 2 ** (reconnectAttempts - 2));
  reconnectTimer = setTimeout(() => {
    if (state.phase === "reconnecting") connect();
  }, delay);
}

// ---------------------------------------------------------------------------
// Audio in

function onSamples(samples, sampleRate) {
  if (!isRunning() || !resampler) return;
  if (sampleRate !== resampler.inRate) resampler = new Resampler(sampleRate, ENGINES[settings.engine].inputRate);
  const pcm = floatToInt16(resampler.process(samples));
  for (const chunk of accumulator.push(pcm)) {
    setMeter(meterLevel(rms(chunk)));
    if (state.phase === "live" && engine?.ready) {
      send(chunk);
    } else {
      preroll.push(chunk);
      if (preroll.length > PREROLL_CHUNKS) preroll.shift();
    }
  }
}

function send(chunk) {
  engine?.sendAudio(chunk);
  debug.sentChunks++;
  debug.sentSamples += chunk.length;
}

// ---------------------------------------------------------------------------
// Translations out

function playAudio(samples, sampleRate) {
  state.outputSeconds += samples.length / sampleRate;
  if (state.muted) return;
  if (settings.skipEnglish && english.isLikelyEnglish) return;
  player.enqueue(samples, sampleRate);
  debug.playedChunks++;
}

function addSource(text, speakerId, untranslated) {
  lastSpeechAt = Date.now();
  english.append(text);
  // Speech that is already English stays on screen as-is and is never read out.
  if (untranslated) transcript.appendTranslation(text, Date.now(), speakerId, true);
  else transcript.appendSource(text, Date.now(), speakerId);
  renderTranscript();
}

function addTranslation(text, speakerId) {
  lastSpeechAt = Date.now();
  transcript.appendTranslation(text, Date.now(), speakerId);
  renderTranscript();
  if (engine?.speaksItself) return;
  for (const sentence of chunker.push(text)) speak(sentence);
  // Say the rest if the speaker trails off without punctuation.
  clearTimeout(chunkerTimer);
  chunkerTimer = setTimeout(speakPending, 1200);
}

function speakPending() {
  clearTimeout(chunkerTimer);
  const rest = chunker.flush();
  if (rest) speak(rest);
}

function speak(sentence) {
  if (state.muted || !isRunning()) return;
  speaker.say(sentence);
  debug.spoken.push(sentence);
}

// ---------------------------------------------------------------------------
// Controls

function toggleMute() {
  if (!isRunning()) return;
  state.muted = !state.muted;
  if (state.muted) {
    player?.skipToLive();
    speaker?.skipToLive();
  }
  renderControls();
}

function skipToLive() {
  player?.skipToLive();
  speaker?.skipToLive();
}

function setBacklog(seconds) {
  state.backlog = Math.max(player?.backlogSeconds ?? 0, seconds);
  renderControls();
}

function tick() {
  if (!isRunning()) return;
  if (state.phase === "live") state.listenSeconds++;
  if (mic && !mic.isLive) {
    fail("The microphone stopped, probably because the screen locked or another app took it. Tap Start to carry on.");
    return;
  }
  const minutes = settings.autoStopMinutes;
  if (minutes > 0 && Date.now() - lastSpeechAt > minutes * 60000) {
    stop(`Stopped after ${minutes} minutes without speech, to save credit.`);
    return;
  }
  renderStats();
}

async function keepAwake() {
  try {
    wakeLock = (await navigator.wakeLock?.request("screen")) ?? null;
  } catch {
    wakeLock = null;
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !isRunning()) return;
  ctx?.resume();
  if (!wakeLock || wakeLock.released) keepAwake();
});

// ---------------------------------------------------------------------------
// Rendering

const PHASE_LABELS = { idle: "Ready", starting: "Connecting", live: "Live", reconnecting: "Reconnecting", failed: "Stopped" };
const rowById = new Map();

function render() {
  const status = $("status");
  status.textContent = PHASE_LABELS[state.phase];
  status.dataset.phase = state.phase;
  renderEngines();
  renderBanner();
  renderTranscript();
  renderInterim();
  renderControls();
  renderStats();
}

function renderEngines() {
  const picker = $("engine-picker");
  if (!picker.childElementCount) {
    for (const spec of Object.values(ENGINES)) {
      const label = document.createElement("label");
      label.className = "engine";
      label.innerHTML = `<input type="radio" name="engine" value="${spec.id}"><span class="engine-name"></span><span class="engine-meta"></span>`;
      label.querySelector(".engine-name").textContent = spec.name.replace(" Realtime Translate", "").replace(" Live Translate", "");
      label.querySelector(".engine-meta").textContent = `${spec.priceLabel} · ${spec.voice === "natural" ? "natural voice" : "device voice"}`;
      label.querySelector("input").addEventListener("change", () => {
        settings.engine = spec.id;
        saveSettings();
        state.notice = null;
        render();
      });
      picker.append(label);
    }
  }
  for (const input of picker.querySelectorAll("input")) {
    input.checked = input.value === settings.engine;
    input.disabled = isRunning();
  }
  picker.classList.toggle("locked", isRunning());
}

function renderBanner() {
  const banner = $("banner");
  const message = state.phase === "failed" ? state.error : state.notice;
  banner.hidden = !message;
  banner.className = `banner ${state.phase === "failed" ? "error" : "info"}`;
  banner.textContent = message || "";
}

function renderTranscript() {
  const list = $("segments");
  const segments = transcript.segments;
  $("empty").hidden = segments.length > 0 || isRunning();
  const keep = new Set(segments.map((segment) => segment.id));
  for (const [id, row] of rowById) {
    if (!keep.has(id)) {
      row.remove();
      rowById.delete(id);
    }
  }
  const nearBottom = isNearBottom();
  for (const segment of segments) {
    let row = rowById.get(segment.id);
    if (!row) {
      row = document.createElement("li");
      row.className = "segment";
      row.innerHTML = `<p class="translation"></p><p class="source"></p><p class="meta"></p>`;
      list.append(row);
      rowById.set(segment.id, row);
    }
    const englishSource = !segment.translation && looksEnglish(segment.source);
    const main = segment.translation || (englishSource ? segment.source : "");
    row.querySelector(".translation").textContent = main || "…";
    row.querySelector(".translation").classList.toggle("pending", !main);
    const source = row.querySelector(".source");
    source.textContent = englishSource ? "" : segment.source;
    source.hidden = !settings.showSource || !source.textContent;
    const time = new Date(segment.startedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    row.querySelector(".meta").textContent = segment.speaker != null ? `Speaker ${segment.speaker} · ${time}` : time;
  }
  if (nearBottom) scrollToBottom();
}

function renderInterim() {
  const box = $("interim");
  const text = [state.interim.translation, settings.showSource ? state.interim.source : ""].filter(Boolean).join(" · ");
  box.hidden = !text || !isRunning();
  box.textContent = text;
}

function renderControls() {
  const running = isRunning();
  $("start").hidden = running;
  $("running").hidden = !running;
  const mute = $("mute");
  mute.setAttribute("aria-pressed", String(state.muted));
  mute.setAttribute("aria-label", state.muted ? "Unmute voice" : "Mute voice");
  const backlog = Math.max(state.backlog, player?.backlogSeconds ?? 0);
  $("skip").disabled = backlog < 0.5;
  $("backlog").textContent = backlog >= 0.5 ? `${Math.round(backlog)}s` : "";
}

function renderStats() {
  const stats = $("stats");
  stats.hidden = !isRunning() && state.listenSeconds === 0;
  const m = Math.floor(state.listenSeconds / 60);
  const s = String(state.listenSeconds % 60).padStart(2, "0");
  const cost = estimateCost(settings.engine, { listenSeconds: state.listenSeconds, outputSeconds: state.outputSeconds });
  const costText = settings.engine === "gemini" ? `≈ $${cost.toFixed(2)} if on a paid plan` : `≈ $${cost.toFixed(2)}`;
  stats.textContent = `${m}:${s} · ${costText} · ${mic?.label ?? ""}`;
}

function setMeter(level) {
  const bars = $("meter").children;
  for (let i = 0; i < bars.length; i++) bars[i].classList.toggle("lit", level > i / bars.length);
}

function looksEnglish(text) {
  if (!text) return false;
  const tracker = new EnglishTracker();
  tracker.append(text);
  return tracker.isLikelyEnglish;
}

function isNearBottom() {
  const main = $("transcript");
  return main.scrollHeight - main.scrollTop - main.clientHeight < 120;
}

function scrollToBottom() {
  const main = $("transcript");
  main.scrollTop = main.scrollHeight;
}

// ---------------------------------------------------------------------------
// Settings sheet

function openSettings(focusId) {
  const dialog = $("settings");
  for (const id of Object.keys(ENGINES)) $(`key-${id}`).value = settings.keys[id] || "";
  $("catch-up").checked = settings.catchUp;
  $("skip-english").checked = settings.skipEnglish;
  $("show-source").checked = settings.showSource;
  $("auto-stop").value = String(settings.autoStopMinutes);
  fillDevices();
  fillVoices();
  dialog.showModal();
  if (focusId) $(focusId)?.focus();
}

async function fillDevices() {
  const select = $("mic");
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
    select.replaceChildren(new Option("Default", ""));
    devices.forEach((device, index) => select.append(new Option(device.label || `Microphone ${index + 1}`, device.deviceId)));
  } catch {}
  select.value = settings.micId;
  if (select.value !== settings.micId) select.value = "";
}

function fillVoices() {
  const select = $("voice");
  select.replaceChildren(new Option("Best available", ""));
  for (const voice of Speaker.englishVoices()) select.append(new Option(`${voice.name} (${voice.lang})`, voice.voiceURI));
  select.value = settings.voiceURI;
  if (select.value !== settings.voiceURI) select.value = "";
}

function readSettingsForm() {
  for (const id of Object.keys(ENGINES)) settings.keys[id] = $(`key-${id}`).value.trim();
  settings.micId = $("mic").value;
  settings.voiceURI = $("voice").value;
  settings.catchUp = $("catch-up").checked;
  settings.skipEnglish = $("skip-english").checked;
  settings.showSource = $("show-source").checked;
  settings.autoStopMinutes = Number($("auto-stop").value);
  saveSettings();
  if (player) player.catchUp = settings.catchUp;
  if (speaker) {
    speaker.catchUp = settings.catchUp;
    speaker.voiceURI = settings.voiceURI;
  }
  if (state.notice?.startsWith("Add your") && settings.keys[settings.engine]) state.notice = null;
  render();
}

// ---------------------------------------------------------------------------
// Wire up

$("start").addEventListener("click", start);
$("stop").addEventListener("click", () => stop());
$("mute").addEventListener("click", toggleMute);
$("skip").addEventListener("click", skipToLive);
$("open-settings").addEventListener("click", () => openSettings());
$("settings").addEventListener("close", readSettingsForm);
if (Speaker.supported) speechSynthesis.addEventListener?.("voiceschanged", () => $("settings").open && fillVoices());

// Lock-screen / headphone controls where the browser supports them.
if ("mediaSession" in navigator) {
  try {
    navigator.mediaSession.setActionHandler("pause", toggleMute);
    navigator.mediaSession.setActionHandler("play", toggleMute);
    navigator.mediaSession.setActionHandler("nexttrack", skipToLive);
  } catch {}
}

render();
if (!settings.keys[settings.engine] && !ENDPOINT_OVERRIDE) {
  state.notice = "Pick a service above and add its API key in Settings (⚙︎) to get started.";
  renderBanner();
}
