const webcam = document.getElementById("webcam");
const snapshot = document.getElementById("snapshot");
const processing = document.getElementById("processing");
const proofConsole = document.getElementById("proofConsole");
const humanBadge = document.getElementById("humanBadge");
const streamStatus = document.getElementById("streamStatus");
const playerHashLabel = document.getElementById("playerHash");
const potDisplay = document.getElementById("potDisplay");
const winnerPanel = document.getElementById("winnerPanel");
const playersList = document.getElementById("playersList");
const gameIdInput = document.getElementById("gameIdInput");
const joinGameBtn = document.getElementById("joinGameBtn");
const gameStatus = document.getElementById("gameStatus");
const simulateBtn = document.getElementById("simulateBtn");
const stopStreamBtn = document.getElementById("stopStreamBtn");
const addBotBtn = document.getElementById("addBotBtn");
const removeBotBtn = document.getElementById("removeBotBtn");

const verifyFaceBtn = document.getElementById("verifyFaceBtn");
const dealBtn = document.getElementById("dealBtn");
const verifyHandBtn = document.getElementById("verifyHandBtn");
const foldBtn = document.getElementById("foldBtn");
const checkBtn = document.getElementById("checkBtn");
const callBtn = document.getElementById("callBtn");
const raiseBtn = document.getElementById("raiseBtn");

const sessionStore = window.sessionStorage;
const localStore = window.localStorage;

const state = {
  playerKey:
    sessionStore.getItem("zkpoker.playerKey") ||
    crypto.getRandomValues(new Uint32Array(4)).join("-"),
  playerHash: sessionStore.getItem("zkpoker.playerHash"),
  gameId: localStore.getItem("zkpoker.gameId"),
  game: null,
  deckCommitment: null,
  encryptedHand: null,
  handProof: null,
  livenessTimer: null,
  stream: null,
  faceModelReady: false,
  faceModelError: null,
  faceDetectBusy: false,
  faceDetectIntervalMs: 1500,
  faceHistory: [],
  lockedFaceDescriptor: null,
  lockedDescriptorSamples: [],
  faceMismatchCount: 0,
  lastBotActionSig: null,
  forceFaceRelock: false
};

sessionStore.setItem("zkpoker.playerKey", state.playerKey);
if (state.gameId && gameIdInput) {
  gameIdInput.value = state.gameId;
}
const storedDescriptor = sessionStore.getItem("zkpoker.lockedFaceDescriptor");
if (storedDescriptor) {
  try {
    state.lockedFaceDescriptor = JSON.parse(storedDescriptor);
  } catch (error) {
    state.lockedFaceDescriptor = null;
  }
}

function logProof(label, payload) {
  const entry = `[${new Date().toLocaleTimeString()}] ${label}\n${JSON.stringify(
    payload,
    null,
    2
  )}\n`;
  proofConsole.textContent = entry + proofConsole.textContent;
}

async function api(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Request failed: ${res.status} ${text}`);
  }
  return res.json();
}

async function initWebcam() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 320, height: 240 }
    });
    webcam.srcObject = stream;
    state.stream = stream;
    stopStreamBtn.textContent = "Close Stream";
    streamStatus.textContent = "Stream: live";
    streamStatus.classList.remove("muted", "bad", "warn");
    stream.getVideoTracks().forEach((track) => {
      track.onended = () => {
        streamStatus.textContent = "Stream: offline";
        streamStatus.classList.add("bad");
        humanBadge.textContent = "Human: liveness failed";
        humanBadge.classList.add("bad");
      };
    });
    webcam.onloadeddata = () => {
      drawSnapshot();
    };
    startLiveness();
  } catch (error) {
    logProof("Webcam error", { error: error.message });
    streamStatus.textContent = "Stream: blocked";
    streamStatus.classList.add("bad");
  }
}

function stopWebcam() {
  if (state.stream) {
    state.stream.getTracks().forEach((track) => track.stop());
    state.stream = null;
  }
  webcam.srcObject = null;
  stopStreamBtn.textContent = "Open Stream";
  const snapCtx = snapshot.getContext("2d");
  snapCtx.clearRect(0, 0, snapshot.width, snapshot.height);
  streamStatus.textContent = "Stream: offline";
  streamStatus.classList.add("bad");
  setBadge(humanBadge, "Human: liveness failed", "bad");
}

function captureFrame() {
  try {
    const ctx = processing.getContext("2d");
    ctx.drawImage(webcam, 0, 0, processing.width, processing.height);
    const imageData = ctx.getImageData(0, 0, processing.width, processing.height);
    return Array.from(imageData.data).slice(0, 400).join(",");
  } catch (error) {
    return null;
  }
}

function drawSnapshot() {
  if (!state.stream || webcam.readyState < 2) {
    return;
  }
  const snapCtx = snapshot.getContext("2d");
  snapCtx.drawImage(webcam, 0, 0, snapshot.width, snapshot.height);
}

async function initFaceModel() {
  if (state.faceModelReady || state.faceModelError) {
    return;
  }
  try {
    const MODEL_URL =
      "https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@0.22.2/weights";
    await faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL);
    await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
    await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
    await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
    state.faceModelReady = true;
  } catch (error) {
    state.faceModelError = error.message;
    logProof("Face model error", { error: error.message });
  }
}

function getFrameData() {
  try {
    const ctx = processing.getContext("2d");
    ctx.drawImage(webcam, 0, 0, processing.width, processing.height);
    return ctx.getImageData(0, 0, processing.width, processing.height);
  } catch (error) {
    return null;
  }
}

function descriptorDistance(a, b) {
  if (!a || !b || a.length !== b.length) {
    return Number.POSITIVE_INFINITY;
  }
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

function storeLockedDescriptor(descriptor) {
  if (!descriptor) {
    return;
  }
  const array = Array.from(descriptor);
  state.lockedFaceDescriptor = array;
  sessionStore.setItem("zkpoker.lockedFaceDescriptor", JSON.stringify(array));
}

function addLockedDescriptorSample(descriptor) {
  if (!descriptor) {
    return;
  }
  const array = Array.from(descriptor);
  state.lockedDescriptorSamples.push(array);
  if (state.lockedDescriptorSamples.length > 5) {
    state.lockedDescriptorSamples.shift();
  }
}

function minDescriptorDistance(samples, descriptor) {
  if (!samples.length || !descriptor) {
    return Number.POSITIVE_INFINITY;
  }
  let best = Number.POSITIVE_INFINITY;
  for (const sample of samples) {
    const dist = descriptorDistance(sample, descriptor);
    if (dist < best) {
      best = dist;
    }
  }
  return best;
}

async function getDescriptorFromCanvas(canvasEl) {
  if (!canvasEl) {
    return null;
  }
  await initFaceModel();
  if (!state.faceModelReady) {
    return null;
  }
  const detection = await faceapi
    .detectSingleFace(
      canvasEl,
      new faceapi.SsdMobilenetv1Options({
        minConfidence: 0.25
      })
    )
    .withFaceLandmarks()
    .withFaceDescriptor();
  if (!detection) {
    return null;
  }
  return detection.descriptor || null;
}

async function detectFaceDetections() {
  if (!state.stream) {
    return [];
  }
  if (state.faceDetectBusy) {
    return [];
  }
  if (webcam.readyState < 2) {
    return [];
  }
  await initFaceModel();
  if (!state.faceModelReady) {
    return [];
  }
  state.faceDetectBusy = true;
  try {
    const ssdDetections = await faceapi.detectAllFaces(
      webcam,
      new faceapi.SsdMobilenetv1Options({
        minConfidence: 0.25
      })
    );
    if (ssdDetections && ssdDetections.length > 0) {
      return ssdDetections;
    }
    const tinyDetections = await faceapi.detectAllFaces(
      webcam,
      new faceapi.TinyFaceDetectorOptions({
        inputSize: 416,
        scoreThreshold: 0.2
      })
    );
    return tinyDetections || [];
  } finally {
    state.faceDetectBusy = false;
  }
}

function updateFaceHistory(detected) {
  state.faceHistory.push(Boolean(detected));
  if (state.faceHistory.length > 3) {
    state.faceHistory.shift();
  }
  const positives = state.faceHistory.filter(Boolean).length;
  const negatives = state.faceHistory.length - positives;
  if (positives >= 2) {
    return "identified";
  }
  if (negatives >= 2) {
    return "un-identified";
  }
  return "pending";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function poseidonHashMock(input) {
  const encoder = new TextEncoder();
  const data = encoder.encode(String(input));
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = Array.from(new Uint8Array(digest));
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function decodeBase64Url(value) {
  const base = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base + "=".repeat((4 - (base.length % 4)) % 4);
  return atob(padded);
}

function formatCard(card) {
  if (!card) {
    return "??";
  }
  const trimmed = String(card).trim();
  if (!trimmed) {
    return "??";
  }
  const suit = trimmed.slice(-1);
  const rank = trimmed.slice(0, -1);
  const suitMap = { S: "♠", H: "♥", D: "♦", C: "♣" };
  if (suitMap[suit]) {
    return `${rank}${suitMap[suit]}`;
  }
  return trimmed;
}

function getDecodedHand(encryptedHand) {
  if (!encryptedHand || !Array.isArray(encryptedHand.cards)) {
    return null;
  }
  const cards = encryptedHand.cards.map((enc) => {
    const decoded = decodeBase64Url(enc);
    return formatCard(decoded.split("|")[0]);
  });
  return cards.length ? cards : null;
}

function renderCommunityCards(cards) {
  const cardEls = document.querySelectorAll(".community-cards .card");
  cardEls.forEach((el, idx) => {
    el.textContent = formatCard(cards[idx]);
  });
}

function setBadge(el, text, style) {
  el.textContent = text;
  el.classList.remove("muted", "bad", "warn");
  if (style) {
    el.classList.add(style);
  }
}

function renderPlayers(players) {
  if (!players.length) {
    playersList.textContent = "No players yet.";
    return;
  }
  playersList.innerHTML = players
    .map((player, index) => {
      const shortHash = player.isBot
        ? player.hash
        : `${player.hash.slice(0, 10)}...`;
      const liveClass = player.isBot
        ? "live"
        : player.active === false
        ? "offline"
        : "live";
      const verifiedLabel = player.isBot
        ? "bot"
        : player.verified === undefined
        ? "pending"
        : player.verified
        ? "verified"
        : "unverified";
      const botLabel = player.isBot ? "" : "";
      const turn =
        state.game && state.game.currentTurnIndex === index ? " turn" : "";
      const foldedClass = player.folded ? " folded" : "";
      return `<div class="player-row${foldedClass}"><span class="dot ${liveClass}"></span>${shortHash} | ${verifiedLabel}${turn}</div>`;
    })
    .join("");
}

async function refreshStatus() {
  if (!state.gameId) {
    return;
  }
  const res = await fetch(`/api/game/status?gameId=${state.gameId}`);
  if (!res.ok) {
    return;
  }
  const data = await res.json();
  if (data.game) {
    state.game = data.game;
    updateGameUI();
  }
}

function updateGameUI() {
  const game = state.game;
  if (!game) {
    return;
  }
  renderPlayers(game.players || []);
  potDisplay.textContent = `$${game.pot ?? 0}`;
  const statusParts = [
    `Game: ${game.id}`,
    `Phase: ${game.phase}`,
    `Bet: ${game.currentBet ?? 0}`,
    game.pendingActors ? `To act: ${game.pendingActors.length}` : null,
    game.lastAction
      ? `Last: ${game.lastAction.action} ${
          game.lastAction.amount ?? 0
        }`
      : null
  ].filter(Boolean);
  gameStatus.textContent = statusParts.join(" | ");
  winnerPanel.textContent = game.winner
    ? `${game.winner}`
    : "No winner yet.";
  renderCommunityCards(game.community || []);
  updateSeats(game.players || [], game.currentTurnIndex, game.winner);
  const isMyTurn =
    game.players?.[game.currentTurnIndex]?.hash === state.playerHash;
  setActionsEnabled(Boolean(isMyTurn));
  updateActionButtons(game.currentBet ?? 0, Boolean(isMyTurn));
  logBotAction(game);

  if (game.phase === "showdown" && state.encryptedHand) {
    updateSeats(game.players || [], game.currentTurnIndex, game.winner);
  }
}

function logBotAction(game) {
  if (!game.lastAction) {
    return;
  }
  const player = game.lastAction.player || "";
  if (!player.startsWith("bot-")) {
    return;
  }
  const sig = `${player}|${game.lastAction.action}|${game.lastAction.amount}|${game.phase}|${game.pot}`;
  if (state.lastBotActionSig === sig) {
    return;
  }
  state.lastBotActionSig = sig;
  logProof("Bot move", game.lastAction);
}

function setActionsEnabled(enabled) {
  [foldBtn, checkBtn, callBtn, raiseBtn].forEach((btn) => {
    btn.disabled = false;
    btn.style.opacity = enabled ? "1" : "0.85";
    btn.style.cursor = "pointer";
  });
}

function updateActionButtons(currentBet, isMyTurn) {
  const canCheck = currentBet === 0;
  checkBtn.style.opacity = canCheck ? "1" : "0.7";
  callBtn.style.opacity = canCheck ? "0.7" : "1";
  [foldBtn, checkBtn, callBtn, raiseBtn].forEach((btn) => {
    btn.style.cursor = "pointer";
  });
}

function updateSeats(players, turnIndex, winnerHash) {
  const seatMap = [
    document.querySelector(".seat-bottom .name"),
    document.querySelector(".seat-top .name"),
    document.querySelector(".seat-left .name"),
    document.querySelector(".seat-right .name")
  ];
  const stackMap = [
    document.querySelector(".seat-bottom .stack"),
    document.querySelector(".seat-top .stack"),
    document.querySelector(".seat-left .stack"),
    document.querySelector(".seat-right .stack")
  ];
  const cardMap = [
    document.querySelector(".seat-bottom .hole-cards"),
    document.querySelector(".seat-top .hole-cards"),
    document.querySelector(".seat-left .hole-cards"),
    document.querySelector(".seat-right .hole-cards")
  ];
  seatMap.forEach((el, idx) => {
    const player = players[idx];
    if (!el) {
      return;
    }
    if (player) {
      const label =
        player.hash === state.playerHash ? "You" : player.hash.slice(0, 6);
      const turn = idx === turnIndex ? " (turn)" : "";
      const winner = player.hash === winnerHash ? " (winner)" : "";
      el.textContent = `${label}${turn}${winner}`;
      el.classList.toggle("turn", idx === turnIndex);
      el.classList.toggle("folded", Boolean(player.folded));
    } else {
      el.textContent = "Empty seat";
      el.classList.remove("turn", "folded");
    }
  });
  stackMap.forEach((el, idx) => {
    if (!el) {
      return;
    }
    const player = players[idx];
    el.textContent = player ? `$${player.stack ?? 100}` : "$0";
  });

  const myCards = getDecodedHand(state.encryptedHand);
  cardMap.forEach((el, idx) => {
    if (!el) {
      return;
    }
    const player = players[idx];
    const cards =
      player?.hash === state.playerHash && myCards
        ? myCards
        : state.game?.revealedHands?.[player?.hash] || null;
    const cardEls = el.querySelectorAll(".card");
    cardEls.forEach((cardEl, cardIdx) => {
      cardEl.textContent = cards ? formatCard(cards[cardIdx]) : "??";
    });
  });
}

async function verifyHuman() {
  try {
    if (state.playerHash) {
      const locked = await ensureFaceLock();
      if (!locked) {
        logProof("Verify Human", {
          status: "un-identified",
          reason: "no face detected"
        });
        setBadge(humanBadge, "Human: un-identified", "bad");
        return;
      }
      await api("/api/join-table", { playerHash: state.playerHash });
      await api("/api/register-key", {
        playerHash: state.playerHash,
        playerKey: state.playerKey
      });
      playerHashLabel.textContent = `Player hash: ${state.playerHash.slice(
        0,
        16
      )}...`;
      setBadge(humanBadge, "Human: identified", "");
      logProof("Verify Human", { status: "identified", reason: "face matched" });
      startLiveness();
      return;
    }
    if (!state.stream) {
      logProof("Verify Human", {
        status: "un-identified",
        reason: "webcam stream unavailable"
      });
      setBadge(humanBadge, "Human: un-identified", "bad");
      return;
    }
    const locked = await ensureFaceLock();
    if (!locked) {
      logProof("Verify Human", {
        status: "un-identified",
        reason: "no face detected"
      });
      setBadge(humanBadge, "Human: un-identified", "bad");
      return;
    }
    const frames = [];
    const frame = captureFrame();
    if (!frame) {
      setBadge(humanBadge, "Human: un-identified", "bad");
      return;
    }
    frames.push(frame);
    const embedding = await poseidonHashMock(frames.join("|"));
    const result = await api("/api/face-verify", { embedding });
    state.playerHash = result.hash;
    sessionStore.setItem("zkpoker.playerHash", result.hash);
    playerHashLabel.textContent = `Player hash: ${result.hash.slice(0, 16)}...`;
    setBadge(
      humanBadge,
      result.unique ? "Human: identified" : "Human: identified",
      result.unique ? "" : "warn"
    );
    logProof("Face proof", result);
    logProof("Verify Human", { status: "identified", reason: "face matched" });
    await api("/api/join-table", { playerHash: result.hash });
    await api("/api/register-key", {
      playerHash: result.hash,
      playerKey: state.playerKey
    });
    if (!state.gameId && gameIdInput.value) {
      await joinGame();
    } else if (state.gameId) {
      await joinGame();
    }
    startLiveness();
  } catch (error) {
    logProof("Face proof error", { error: error.message });
    setBadge(humanBadge, "Human: verify failed", "bad");
  }
}

async function dealHands() {
  if (!state.gameId) {
    await joinGame();
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const res = await fetch(
      `/api/game/hand?gameId=${state.gameId}&playerHash=${state.playerHash}`
    );
    if (!res.ok) {
      await sleep(300);
      continue;
    }
    const result = await res.json();
    state.deckCommitment = result.deckCommitment;
    state.encryptedHand = result.encryptedHand;
    state.handProof = result.proof;
    logProof("Deal proof", result.proof);
    updateGameUI();
    return;
  }
  logProof("Deal error", { error: "Hand not ready yet." });
}

async function verifyHand() {
  if (!state.encryptedHand) {
    await dealHands();
    if (!state.encryptedHand) {
      logProof("Verify hand", { error: "No hand dealt yet." });
      return;
    }
  }
  const result = await api("/api/verify-hand", {
    deckCommitment: state.deckCommitment,
    encryptedHand: state.encryptedHand,
    proof: state.handProof
  });
  logProof("Hand verification", result);
}

async function sendAction(action, amount = 0) {
  if (!state.gameId) {
    logProof("Action error", { error: "Join a game first." });
    return null;
  }
  try {
    const result = await api("/api/game/action", {
      gameId: state.gameId,
      playerHash: state.playerHash,
      action,
      amount
    });
    logProof(`Action: ${action}`, result);
    if (result.game) {
      state.game = result.game;
      updateGameUI();
    }
    return result;
  } catch (error) {
    logProof(`Action error: ${action}`, { error: error.message });
    return null;
  }
}

async function placeBet(amount) {
  const action = amount === 0 ? "fold" : "call";
  await sendAction(action, amount);
}

async function settleHand() {
  if (!state.encryptedHand) {
    return;
  }
  const result = await api("/api/settle", {
    winnerIndex: 0,
    deckCommitment: state.deckCommitment,
    encryptedHand: state.encryptedHand,
    proof: state.handProof
  });
  winnerPanel.textContent = `Winner: ${result.winner} | Paid out: ${result.paidOut}`;
  logProof("Settlement proof", result);
  potDisplay.textContent = "$0";
}


verifyFaceBtn.addEventListener("click", async () => {
  state.forceFaceRelock = true;
  await verifyHuman();
});
dealBtn.addEventListener("click", dealHands);
verifyHandBtn.addEventListener("click", verifyHand);

foldBtn.addEventListener("click", () => placeBet(0));
checkBtn.addEventListener("click", async () => {
  await sendAction("check", 0);
});
callBtn.addEventListener("click", async () => {
  const currentBet = state.game?.currentBet || 0;
  if (currentBet === 0) {
    await sendAction("check", 0);
    return;
  }
  await sendAction("call", currentBet);
});
raiseBtn.addEventListener("click", async () => {
  await sendAction("raise", (state.game?.currentBet || 0) + 20);
});

initWebcam();
setInterval(refreshStatus, 2500);
refreshStatus();

async function joinGame() {
  const gameId = String(gameIdInput.value || "").trim();
  if (!gameId) {
    gameStatus.textContent = "Enter a game id first.";
    return;
  }
  if (!state.playerHash) {
    await verifyHuman();
  }
  await api("/api/register-key", {
    playerHash: state.playerHash,
    playerKey: state.playerKey
  });
  const result = await api("/api/game/join", {
    gameId,
    playerHash: state.playerHash
  });
  state.gameId = gameId;
  localStore.setItem("zkpoker.gameId", gameId);
  state.game = result.game;
  updateGameUI();
  await dealHands();
}

joinGameBtn.addEventListener("click", joinGame);
simulateBtn.addEventListener("click", async () => {
  if (!state.gameId) {
    await joinGame();
  }
  await simulateGame();
});
addBotBtn.addEventListener("click", async () => {
  if (!state.gameId) {
    const gameId = String(gameIdInput.value || "demo").trim();
    gameIdInput.value = gameId;
    state.gameId = gameId;
    localStore.setItem("zkpoker.gameId", gameId);
  }
  const result = await api("/api/game/bots/add", {
    gameId: state.gameId,
    count: 1
  });
  if (result.game) {
    state.game = result.game;
    updateGameUI();
  }
});
removeBotBtn.addEventListener("click", async () => {
  if (!state.gameId) {
    const gameId = String(gameIdInput.value || "demo").trim();
    gameIdInput.value = gameId;
    state.gameId = gameId;
    localStore.setItem("zkpoker.gameId", gameId);
  }
  const result = await api("/api/game/bots/remove", {
    gameId: state.gameId,
    count: 1
  });
  if (result.game) {
    state.game = result.game;
    updateGameUI();
  }
});

async function simulateGame() {
  let safety = 0;
  while (safety < 60) {
    safety += 1;
    const res = await fetch(`/api/game/status?gameId=${state.gameId}`);
    if (!res.ok) {
      logProof("Simulate error", { error: "Game not available." });
      return;
    }
    const data = await res.json();
    state.game = data.game;
    updateGameUI();
    if (!state.game || state.game.phase === "showdown") {
      return;
    }
    const pending = state.game.pendingActors || [];
    for (const playerHash of pending) {
      await api("/api/game/action", {
        gameId: state.gameId,
        playerHash,
        action: state.game.currentBet > 0 ? "call" : "check",
        amount: state.game.currentBet > 0 ? state.game.currentBet : 0
      });
      await sleep(250);
    }
  }
  logProof("Simulate warning", { error: "Simulation exceeded steps." });
}
stopStreamBtn.addEventListener("click", () => {
  if (state.stream) {
    stopWebcam();
    return;
  }
  initWebcam();
});

function startLiveness() {
  if (state.livenessTimer) {
    return;
  }
  state.livenessTimer = setInterval(async () => {
    if (!state.playerHash || !state.stream) {
      setBadge(humanBadge, "Human: un-identified", "bad");
      setBadge(streamStatus, "Stream: offline", "bad");
      return;
    }
    try {
      const locked = await ensureFaceLock();
      if (!locked) {
        setBadge(humanBadge, "Human: un-identified", "bad");
        return;
      }
      const frame = captureFrame();
      if (!frame) {
        setBadge(humanBadge, "Human: un-identified", "bad");
        setBadge(streamStatus, "Stream: blocked", "bad");
        return;
      }
      const embedding = await poseidonHashMock(frame);
      const result = await api("/api/liveness", {
        playerHash: state.playerHash,
        embedding
      });
      if (result.alive) {
        setBadge(humanBadge, "Human: identified", "");
        setBadge(streamStatus, "Stream: live", "");
      } else {
        setBadge(humanBadge, "Human: un-identified", "bad");
      }
    } catch (error) {
      setBadge(humanBadge, "Human: un-identified", "bad");
      logProof("Liveness error", { error: error.message });
    }
  }, state.faceDetectIntervalMs);
}

async function ensureFaceLock() {
  if (!state.stream) {
    return false;
  }
  if (state.forceFaceRelock) {
    state.lockedFaceDescriptor = null;
    state.lockedDescriptorSamples = [];
    state.faceMismatchCount = 0;
    sessionStore.removeItem("zkpoker.lockedFaceDescriptor");
    state.forceFaceRelock = false;
  }
  const detections = await detectFaceDetections();
  if (detections.length === 0) {
    return false;
  }
  if (!state.lockedFaceDescriptor) {
    const snapCtx = snapshot.getContext("2d");
    snapCtx.drawImage(webcam, 0, 0, snapshot.width, snapshot.height);
    const snapDescriptor = await getDescriptorFromCanvas(snapshot);
    if (!snapDescriptor) {
      return false;
    }
    storeLockedDescriptor(snapDescriptor);
    state.lockedDescriptorSamples = [];
    addLockedDescriptorSample(snapDescriptor);
    state.faceMismatchCount = 0;
    return true;
  }
  const liveDescriptor = await getDescriptorFromCanvas(webcam);
  if (!liveDescriptor) {
    return false;
  }
  const descriptorDist = Math.min(
    descriptorDistance(state.lockedFaceDescriptor, liveDescriptor),
    minDescriptorDistance(state.lockedDescriptorSamples, liveDescriptor)
  );
  if (descriptorDist > 0.75) {
    state.faceMismatchCount += 1;
    return state.faceMismatchCount < 5;
  }
  state.faceMismatchCount = 0;
  addLockedDescriptorSample(liveDescriptor);
  return true;
}

if (state.playerHash) {
  playerHashLabel.textContent = `Player hash: ${state.playerHash.slice(
    0,
    16
  )}...`;
  startLiveness();
}

if (state.gameId && state.playerHash) {
  joinGame();
}
