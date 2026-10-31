"use strict";

const STORAGE_KEY = "pulsekeeper-settings-v1";
const MIN_BPM = 20;
const MAX_BPM = 320;
const SCHEDULER_LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD_SECONDS = 0.15;

const DEFAULT_STATE = {
  bpm: 100,
  beatsPerBar: 4,
  beatUnit: 4,
  subdivision: 1,
  swing: 0,
  accents: [2, 1, 1, 1],
  sound: "wood",
  volume: 78,
  haptic: false,
  muteEvery: 0
};

const tempoNames = [
  [40, "Grave"],
  [60, "Largo"],
  [76, "Adagio"],
  [108, "Andante"],
  [120, "Moderato"],
  [156, "Allegro"],
  [320, "Presto"]
];

const el = {
  tempoOrbit: document.getElementById("tempoOrbit"),
  tempoNumber: document.getElementById("tempoNumber"),
  tempoRange: document.getElementById("tempoRange"),
  tempoName: document.getElementById("tempoName"),
  meterSummary: document.getElementById("meterSummary"),
  transportStatus: document.getElementById("transportStatus"),
  statusDot: document.getElementById("statusDot"),
  playButton: document.getElementById("playButton"),
  playButtonLabel: document.getElementById("playButtonLabel"),
  tapButton: document.getElementById("tapButton"),
  transportHint: document.getElementById("transportHint"),
  beatsPerBar: document.getElementById("beatsPerBar"),
  beatUnit: document.getElementById("beatUnit"),
  subdivision: document.getElementById("subdivision"),
  subdivisionLabel: document.getElementById("subdivisionLabel"),
  swingRange: document.getElementById("swingRange"),
  swingValue: document.getElementById("swingValue"),
  beatPattern: document.getElementById("beatPattern"),
  volumeRange: document.getElementById("volumeRange"),
  volumeValue: document.getElementById("volumeValue"),
  hapticToggle: document.getElementById("hapticToggle"),
  muteEvery: document.getElementById("muteEvery"),
  soundChoices: Array.from(document.querySelectorAll(".sound-choice")),
  presetCards: Array.from(document.querySelectorAll(".preset-card")),
  installButton: document.getElementById("installButton"),
  fullscreenButton: document.getElementById("fullscreenButton"),
  toast: document.getElementById("toast")
};

let state = loadState();
let audioContext = null;
let schedulerTimer = null;
let nextNoteTime = 0;
let beatIndex = 0;
let subdivisionIndex = 0;
let barIndex = 0;
let isPlaying = false;
let scheduleVersion = 0;
let wakeLock = null;
let deferredInstallPrompt = null;
let tapTimes = [];
let toastTimer = null;
const visualTimers = new Set();

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeState(candidate) {
  const saved = candidate && typeof candidate === "object" ? candidate : {};
  const beatsPerBar = clamp(Math.round(Number(saved.beatsPerBar) || DEFAULT_STATE.beatsPerBar), 1, 12);
  const subdivision = [1, 2, 3, 4].includes(Number(saved.subdivision)) ? Number(saved.subdivision) : DEFAULT_STATE.subdivision;
  const beatUnit = [2, 4, 8, 16].includes(Number(saved.beatUnit)) ? Number(saved.beatUnit) : DEFAULT_STATE.beatUnit;
  const accents = Array.isArray(saved.accents) ? saved.accents.slice(0, beatsPerBar) : [];

  while (accents.length < beatsPerBar) {
    accents.push(accents.length === 0 ? 2 : 1);
  }

  return {
    bpm: clamp(Math.round(Number(saved.bpm) || DEFAULT_STATE.bpm), MIN_BPM, MAX_BPM),
    beatsPerBar: beatsPerBar,
    beatUnit: beatUnit,
    subdivision: subdivision,
    swing: clamp(Math.round(Number(saved.swing) || 0), 0, 66),
    accents: accents.map(function (level) {
      return [0, 1, 2].includes(Number(level)) ? Number(level) : 1;
    }),
    sound: ["wood", "digital", "bell"].includes(saved.sound) ? saved.sound : DEFAULT_STATE.sound,
    volume: clamp(Math.round(Number(saved.volume) || DEFAULT_STATE.volume), 0, 100),
    haptic: Boolean(saved.haptic),
    muteEvery: [0, 2, 4, 8].includes(Number(saved.muteEvery)) ? Number(saved.muteEvery) : 0
  };
}

function loadState() {
  try {
    return normalizeState(JSON.parse(localStorage.getItem(STORAGE_KEY)));
  } catch (error) {
    return normalizeState(DEFAULT_STATE);
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    // Private-mode browsers can reject storage. The metronome still works for this session.
  }
}

function setRangeProgress(input, minimum, maximum) {
  const percent = ((Number(input.value) - minimum) / (maximum - minimum)) * 100;
  input.style.setProperty("--range-progress", percent.toFixed(2) + "%");
}

function getTempoName(bpm) {
  for (let index = 0; index < tempoNames.length; index += 1) {
    if (bpm <= tempoNames[index][0]) {
      return tempoNames[index][1];
    }
  }
  return "Prestissimo";
}

function getSubdivisionLabel() {
  const labels = {
    1: "每拍 1 音",
    2: "每拍 2 音",
    3: "每拍 3 音",
    4: "每拍 4 音"
  };
  return labels[state.subdivision];
}

function renderPattern() {
  const labels = ["静音", "常规", "重音"];
  el.beatPattern.replaceChildren();

  state.accents.forEach(function (level, index) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "beat-cell level-" + level;
    button.dataset.beatIndex = String(index);
    button.setAttribute("aria-label", "第 " + (index + 1) + " 拍，目前为" + labels[level] + "，点击切换");

    const number = document.createElement("span");
    number.textContent = String(index + 1);
    const label = document.createElement("small");
    label.textContent = labels[level];
    button.append(number, label);
    button.addEventListener("click", function () {
      state.accents[index] = level === 1 ? 2 : level === 2 ? 0 : 1;
      renderPattern();
      saveState();
      if (isPlaying) {
        resyncTransport();
      }
    });
    el.beatPattern.append(button);
  });
}

function renderControls() {
  el.tempoNumber.value = String(state.bpm);
  el.tempoRange.value = String(state.bpm);
  setRangeProgress(el.tempoRange, MIN_BPM, MAX_BPM);
  el.tempoName.textContent = getTempoName(state.bpm);
  el.meterSummary.textContent = state.beatsPerBar + " / " + state.beatUnit;
  el.beatsPerBar.value = String(state.beatsPerBar);
  el.beatUnit.value = String(state.beatUnit);
  el.subdivision.value = String(state.subdivision);
  el.subdivisionLabel.textContent = getSubdivisionLabel();
  el.swingRange.value = String(state.swing);
  el.swingValue.value = state.swing + "%";
  el.swingValue.textContent = state.swing + "%";
  setRangeProgress(el.swingRange, 0, 66);
  el.volumeRange.value = String(state.volume);
  el.volumeValue.textContent = state.volume + "%";
  setRangeProgress(el.volumeRange, 0, 100);
  el.hapticToggle.checked = state.haptic;
  el.muteEvery.value = String(state.muteEvery);

  el.soundChoices.forEach(function (button) {
    const active = button.dataset.sound === state.sound;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });

  renderPattern();
  renderPresetState();
}

function renderPresetState() {
  el.presetCards.forEach(function (card) {
    const matches = Number(card.dataset.bpm) === state.bpm &&
      Number(card.dataset.beats) === state.beatsPerBar &&
      Number(card.dataset.unit) === state.beatUnit &&
      Number(card.dataset.subdivision) === state.subdivision &&
      Number(card.dataset.swing || 0) === state.swing;
    card.classList.toggle("active", matches);
  });
}

function updateTransportUi() {
  el.playButton.classList.toggle("running", isPlaying);
  el.playButton.setAttribute("aria-pressed", String(isPlaying));
  el.playButtonLabel.textContent = isPlaying ? "停止" : "开始";
  el.statusDot.classList.toggle("active", isPlaying);
  el.transportStatus.textContent = isPlaying ? "正在播放" : "准备就绪";
  el.transportHint.textContent = isPlaying
    ? "音频以高精度时钟预排，锁屏后请保持浏览器未被系统暂停。"
    : "点击开始，允许浏览器播放节拍声。";
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  el.toast.textContent = message;
  el.toast.classList.add("visible");
  toastTimer = window.setTimeout(function () {
    el.toast.classList.remove("visible");
  }, 2800);
}

function getAudioContext() {
  if (audioContext) {
    return audioContext;
  }

  const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextConstructor) {
    throw new Error("此浏览器不支持 Web Audio API");
  }

  try {
    audioContext = new AudioContextConstructor({ latencyHint: "interactive" });
  } catch (error) {
    audioContext = new AudioContextConstructor();
  }

  audioContext.addEventListener("statechange", function () {
    if (isPlaying && audioContext.state !== "running") {
      el.transportHint.textContent = "音频被浏览器或系统暂停；点击停止后再开始即可恢复。";
    }
  });
  return audioContext;
}

function makeTone(time, accent, subdivision) {
  if (!audioContext || state.volume === 0 || accent === 0) {
    return;
  }

  const context = audioContext;
  const isPrimaryBeat = subdivision === 0;
  const strength = accent === 2 ? 1 : accent === 1 ? 0.68 : 0;
  const subdivisionGain = isPrimaryBeat ? 1 : 0.36;
  const amplitude = Math.max(0.0001, (state.volume / 100) * strength * subdivisionGain);
  const master = context.createGain();
  const pulseDuration = 60 / state.bpm / state.subdivision;
  const preferredDuration = state.sound === "bell" ? 0.085 : 0.048;
  const duration = Math.min(preferredDuration, pulseDuration * 0.58);
  const startingGain = 0.0001;

  master.gain.setValueAtTime(startingGain, time);
  master.gain.exponentialRampToValueAtTime(amplitude, time + 0.002);
  master.gain.exponentialRampToValueAtTime(startingGain, time + duration);
  master.connect(context.destination);

  const primaryFrequency = accent === 2 ? 1680 : 1120;
  const frequency = isPrimaryBeat ? primaryFrequency : 780;
  const oscillator = context.createOscillator();
  oscillator.type = state.sound === "digital" ? "square" : state.sound === "bell" ? "sine" : "triangle";
  oscillator.frequency.setValueAtTime(frequency, time);

  if (state.sound === "wood") {
    oscillator.frequency.exponentialRampToValueAtTime(frequency * 0.58, time + duration);
  }

  oscillator.connect(master);
  oscillator.start(time);
  oscillator.stop(time + duration + 0.012);
  oscillator.onended = function () {
    oscillator.disconnect();
    master.disconnect();
  };

  if (state.sound === "bell") {
    const overtone = context.createOscillator();
    const overtoneGain = context.createGain();
    overtone.type = "sine";
    overtone.frequency.setValueAtTime(frequency * 1.48, time);
    overtoneGain.gain.setValueAtTime(0.0001, time);
    overtoneGain.gain.exponentialRampToValueAtTime(amplitude * 0.32, time + 0.002);
    overtoneGain.gain.exponentialRampToValueAtTime(0.0001, time + duration);
    overtone.connect(overtoneGain);
    overtoneGain.connect(context.destination);
    overtone.start(time);
    overtone.stop(time + duration + 0.012);
    overtone.onended = function () {
      overtone.disconnect();
      overtoneGain.disconnect();
    };
  }
}

function currentBarIsMuted(bar) {
  return state.muteEvery > 0 && bar % state.muteEvery === state.muteEvery - 1;
}

function vibrateForBeat(accent, muted) {
  if (!state.haptic || muted || accent !== 2 || !navigator.vibrate) {
    return;
  }
  navigator.vibrate(13);
}

function clearBeatIndicator() {
  el.beatPattern.querySelectorAll(".is-active").forEach(function (item) {
    item.classList.remove("is-active");
  });
}

function showBeat(beat, accent, muted, version) {
  if (!isPlaying || version !== scheduleVersion) {
    return;
  }
  clearBeatIndicator();
  const cell = el.beatPattern.querySelector('[data-beat-index="' + beat + '"]');
  if (cell) {
    cell.classList.add("is-active");
  }
  el.tempoOrbit.classList.remove("pulse");
  void el.tempoOrbit.offsetWidth;
  el.tempoOrbit.classList.add("pulse");
  vibrateForBeat(accent, muted);
}

function scheduleVisual(time, beat, accent, muted, version) {
  const delay = Math.max(0, (time - audioContext.currentTime) * 1000);
  const timer = window.setTimeout(function () {
    visualTimers.delete(timer);
    showBeat(beat, accent, muted, version);
  }, delay);
  visualTimers.add(timer);
}

function scheduleTick(time, scheduledBeat, scheduledSubdivision, scheduledBar, version) {
  const muted = currentBarIsMuted(scheduledBar);
  const accent = scheduledSubdivision === 0 ? state.accents[scheduledBeat] : 1;

  if (!muted && accent > 0) {
    makeTone(time, accent, scheduledSubdivision);
  }
  if (scheduledSubdivision === 0) {
    scheduleVisual(time, scheduledBeat, accent, muted, version);
  }
}

function advanceTick() {
  const beatDuration = 60 / state.bpm;
  let interval = beatDuration / state.subdivision;

  if (state.subdivision === 2 && state.swing > 0) {
    const swingRatio = state.swing / 100;
    interval = (beatDuration / 2) * (subdivisionIndex === 0 ? 1 + swingRatio : 1 - swingRatio);
  }

  nextNoteTime += interval;
  subdivisionIndex += 1;

  if (subdivisionIndex >= state.subdivision) {
    subdivisionIndex = 0;
    beatIndex += 1;
    if (beatIndex >= state.beatsPerBar) {
      beatIndex = 0;
      barIndex += 1;
    }
  }
}

function scheduler() {
  if (!isPlaying || !audioContext || audioContext.state !== "running") {
    return;
  }

  const version = scheduleVersion;
  while (nextNoteTime < audioContext.currentTime - 0.005) {
    advanceTick();
  }
  while (nextNoteTime < audioContext.currentTime + SCHEDULE_AHEAD_SECONDS) {
    scheduleTick(nextNoteTime, beatIndex, subdivisionIndex, barIndex, version);
    advanceTick();
  }
}

function clearVisualTimers() {
  visualTimers.forEach(function (timer) {
    window.clearTimeout(timer);
  });
  visualTimers.clear();
}

function resyncTransport() {
  if (!isPlaying || !audioContext) {
    return;
  }

  scheduleVersion += 1;
  clearVisualTimers();
  nextNoteTime = audioContext.currentTime + 0.06;
  window.clearInterval(schedulerTimer);
  scheduler();
  schedulerTimer = window.setInterval(scheduler, SCHEDULER_LOOKAHEAD_MS);
}

async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator && document.visibilityState === "visible") {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", function () {
        wakeLock = null;
      });
    }
  } catch (error) {
    // Wake Lock is optional and commonly disabled by battery-saving modes.
  }
}

function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release().catch(function () {});
    wakeLock = null;
  }
}

async function startMetronome() {
  try {
    const context = getAudioContext();
    if (context.state !== "running") {
      await context.resume();
    }
    isPlaying = true;
    beatIndex = 0;
    subdivisionIndex = 0;
    barIndex = 0;
    scheduleVersion += 1;
    nextNoteTime = context.currentTime + 0.06;
    scheduler();
    schedulerTimer = window.setInterval(scheduler, SCHEDULER_LOOKAHEAD_MS);
    requestWakeLock();
    updateTransportUi();
  } catch (error) {
    showToast("无法启动音频。请检查浏览器是否允许此页面播放声音。");
  }
}

function stopMetronome() {
  isPlaying = false;
  scheduleVersion += 1;
  window.clearInterval(schedulerTimer);
  schedulerTimer = null;
  clearVisualTimers();
  clearBeatIndicator();
  el.tempoOrbit.classList.remove("pulse");
  releaseWakeLock();
  updateTransportUi();
}

function toggleMetronome() {
  if (isPlaying) {
    stopMetronome();
  } else {
    startMetronome();
  }
}

function setBpm(value, options) {
  const skipNumberInput = options && options.skipNumberInput;
  state.bpm = clamp(Math.round(Number(value) || state.bpm), MIN_BPM, MAX_BPM);
  if (!skipNumberInput) {
    el.tempoNumber.value = String(state.bpm);
  }
  el.tempoRange.value = String(state.bpm);
  el.tempoName.textContent = getTempoName(state.bpm);
  setRangeProgress(el.tempoRange, MIN_BPM, MAX_BPM);
  renderPresetState();
  saveState();
  if (isPlaying) {
    resyncTransport();
  }
}

function commitTempoInput() {
  const raw = el.tempoNumber.value.replace(/\D+/g, "");
  if (raw === "") {
    el.tempoNumber.value = String(state.bpm);
    return;
  }
  setBpm(Number(raw));
}

function resizeAccents() {
  const prior = state.accents.slice();
  state.accents = Array.from({ length: state.beatsPerBar }, function (_, index) {
    return index < prior.length ? prior[index] : index === 0 ? 2 : 1;
  });
}

function applyPreset(card) {
  state.bpm = clamp(Number(card.dataset.bpm), MIN_BPM, MAX_BPM);
  state.beatsPerBar = clamp(Number(card.dataset.beats), 1, 12);
  state.beatUnit = Number(card.dataset.unit);
  state.subdivision = Number(card.dataset.subdivision);
  state.swing = clamp(Number(card.dataset.swing || 0), 0, 66);
  state.accents = Array.from({ length: state.beatsPerBar }, function (_, index) {
    return index === 0 ? 2 : 1;
  });
  renderControls();
  saveState();
  if (isPlaying) {
    beatIndex = 0;
    subdivisionIndex = 0;
    resyncTransport();
  }
  showToast(card.querySelector("strong").textContent + " 已载入");
}

function handleTapTempo() {
  const now = performance.now();
  tapTimes = tapTimes.filter(function (time) {
    return now - time < 2400;
  });
  tapTimes.push(now);

  if (tapTimes.length < 2) {
    showToast("继续按 2–5 次，自动计算 BPM");
    return;
  }

  const intervals = [];
  for (let index = 1; index < tapTimes.length; index += 1) {
    intervals.push(tapTimes[index] - tapTimes[index - 1]);
  }
  const average = intervals.reduce(function (sum, interval) {
    return sum + interval;
  }, 0) / intervals.length;
  const bpm = 60000 / average;

  if (bpm >= MIN_BPM && bpm <= MAX_BPM) {
    setBpm(bpm);
    showToast("已设为 " + state.bpm + " BPM");
  } else {
    tapTimes = [now];
    showToast("节奏不在 20–320 BPM 范围内，请重新点按。");
  }
}

function setupEvents() {
  document.querySelectorAll("[data-tempo-step]").forEach(function (button) {
    button.addEventListener("click", function () {
      setBpm(state.bpm + Number(button.dataset.tempoStep));
    });
  });

  el.tempoOrbit.addEventListener("click", function (event) {
    if (event.target !== el.tempoNumber) {
      el.tempoNumber.focus();
      el.tempoNumber.select();
    }
  });

  el.tempoNumber.addEventListener("focus", function () {
    el.tempoNumber.select();
  });

  el.tempoNumber.addEventListener("input", function () {
    const cleaned = el.tempoNumber.value.replace(/\D+/g, "").slice(0, 3);
    if (el.tempoNumber.value !== cleaned) {
      el.tempoNumber.value = cleaned;
    }
    const parsed = Number(cleaned);
    if (cleaned !== "" && parsed >= MIN_BPM && parsed <= MAX_BPM) {
      setBpm(parsed, { skipNumberInput: true });
    }
  });

  el.tempoNumber.addEventListener("blur", commitTempoInput);

  el.tempoNumber.addEventListener("keydown", function (event) {
    if (event.key === "Enter") {
      event.preventDefault();
      commitTempoInput();
      el.tempoNumber.blur();
    } else if (event.key === "Escape") {
      event.preventDefault();
      el.tempoNumber.value = String(state.bpm);
      el.tempoNumber.blur();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setBpm(state.bpm + 1);
      el.tempoNumber.select();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setBpm(state.bpm - 1);
      el.tempoNumber.select();
    }
  });

  el.tempoRange.addEventListener("input", function () {
    setBpm(el.tempoRange.value);
  });
  el.playButton.addEventListener("click", toggleMetronome);
  el.tapButton.addEventListener("click", handleTapTempo);

  el.beatsPerBar.addEventListener("change", function () {
    state.beatsPerBar = Number(el.beatsPerBar.value);
    resizeAccents();
    beatIndex = 0;
    subdivisionIndex = 0;
    renderControls();
    saveState();
    if (isPlaying) {
      resyncTransport();
    }
  });

  el.beatUnit.addEventListener("change", function () {
    state.beatUnit = Number(el.beatUnit.value);
    el.meterSummary.textContent = state.beatsPerBar + " / " + state.beatUnit;
    renderPresetState();
    saveState();
  });

  el.subdivision.addEventListener("change", function () {
    state.subdivision = Number(el.subdivision.value);
    subdivisionIndex = 0;
    el.subdivisionLabel.textContent = getSubdivisionLabel();
    renderPresetState();
    saveState();
    if (isPlaying) {
      resyncTransport();
    }
  });

  el.swingRange.addEventListener("input", function () {
    state.swing = Number(el.swingRange.value);
    el.swingValue.value = state.swing + "%";
    el.swingValue.textContent = state.swing + "%";
    setRangeProgress(el.swingRange, 0, 66);
    renderPresetState();
    saveState();
    if (isPlaying && state.subdivision === 2) {
      resyncTransport();
    }
  });

  el.volumeRange.addEventListener("input", function () {
    state.volume = Number(el.volumeRange.value);
    el.volumeValue.textContent = state.volume + "%";
    setRangeProgress(el.volumeRange, 0, 100);
    saveState();
  });

  el.hapticToggle.addEventListener("change", function () {
    state.haptic = el.hapticToggle.checked;
    saveState();
    if (state.haptic && !navigator.vibrate) {
      showToast("此浏览器未提供振动反馈，声音节拍仍可正常使用。");
    }
  });

  el.muteEvery.addEventListener("change", function () {
    state.muteEvery = Number(el.muteEvery.value);
    saveState();
    if (isPlaying) {
      barIndex = 0;
      resyncTransport();
    }
  });

  el.soundChoices.forEach(function (button) {
    button.addEventListener("click", function () {
      state.sound = button.dataset.sound;
      el.soundChoices.forEach(function (choice) {
        const active = choice === button;
        choice.classList.toggle("active", active);
        choice.setAttribute("aria-pressed", String(active));
      });
      saveState();
    });
  });

  el.presetCards.forEach(function (card) {
    card.addEventListener("click", function () {
      applyPreset(card);
    });
  });

  el.fullscreenButton.addEventListener("click", async function () {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen();
      } else {
        showToast("此浏览器不支持网页全屏。");
      }
    } catch (error) {
      showToast("无法切换全屏。");
    }
  });

  window.addEventListener("keydown", function (event) {
    if (event.code !== "Space" || event.repeat) {
      return;
    }
    const tagName = document.activeElement && document.activeElement.tagName;
    if (tagName === "INPUT" || tagName === "SELECT" || tagName === "BUTTON") {
      return;
    }
    event.preventDefault();
    toggleMetronome();
  });

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && isPlaying) {
      requestWakeLock();
      if (audioContext && audioContext.state !== "running") {
        audioContext.resume().catch(function () {});
      }
    }
  });
}

function setupInstall() {
  window.addEventListener("beforeinstallprompt", function (event) {
    event.preventDefault();
    deferredInstallPrompt = event;
    el.installButton.classList.remove("is-hidden");
  });

  el.installButton.addEventListener("click", async function () {
    if (!deferredInstallPrompt) {
      showToast("请在 Chrome 菜单中选择“安装应用”或“添加到主屏幕”。");
      return;
    }
    deferredInstallPrompt.prompt();
    const result = await deferredInstallPrompt.userChoice;
    if (result.outcome === "accepted") {
      showToast("已添加到主屏幕。");
    }
    deferredInstallPrompt = null;
    el.installButton.classList.add("is-hidden");
  });

  window.addEventListener("appinstalled", function () {
    deferredInstallPrompt = null;
    el.installButton.classList.add("is-hidden");
    showToast("Pulsekeeper 已安装，可离线使用。");
  });
}

function setupServiceWorker() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js").catch(function () {
        // Offline install is an enhancement; the normal page should remain usable.
      });
    });
  }
}

renderControls();
updateTransportUi();
setupEvents();
setupInstall();
setupServiceWorker();
