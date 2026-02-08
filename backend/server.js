import express from "express";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import {
  poseidonHashMock,
  encryptCardMock,
  createProofMock
} from "./zk.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "..", "frontend")));

const state = {
  deckCommitment: null,
  encryptedHands: [],
  faceHashes: new Set(),
  players: new Map(),
  playerKeys: new Map(),
  games: new Map(),
  pot: 0,
  lastWinner: null
};

function buildDeck() {
  const suits = ["S", "H", "D", "C"];
  const ranks = [
    "A",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "10",
    "J",
    "Q",
    "K"
  ];
  const deck = [];
  for (const suit of suits) {
    for (const rank of ranks) {
      deck.push(`${rank}${suit}`);
    }
  }
  return deck;
}

function shuffleDeck(deck) {
  const arr = [...deck];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(0, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

app.get("/api/status", (req, res) => {
  const now = Date.now();
  const players = Array.from(state.players.values()).map((player) => ({
    ...player,
    active: now - player.lastSeen < 10000
  }));
  res.json({
    players,
    pot: state.pot,
    lastWinner: state.lastWinner,
    deckCommitment: state.deckCommitment,
    games: Array.from(state.games.keys())
  });
});

app.post("/api/shuffle", (req, res) => {
  const { playerKeys = [] } = req.body;
  const hashes = Array.from(state.players.keys());
  const participants = hashes.filter((hash) => state.playerKeys.get(hash));
  const keysFromState = participants.map((hash) => state.playerKeys.get(hash));
  const resolvedKeys = playerKeys.length > 0 ? playerKeys : keysFromState;
  const deck = shuffleDeck(buildDeck());
  const deckCommitment = poseidonHashMock(deck.join(","));
  const encryptedHands = resolvedKeys.map((key, index) => {
    const card1 = deck[index * 2];
    const card2 = deck[index * 2 + 1];
    return {
      playerIndex: index,
      playerHash: participants[index] || `player-${index}`,
      cards: [
        encryptCardMock(card1, key),
        encryptCardMock(card2, key)
      ]
    };
  });

  const proof = createProofMock({ encryptedHands, deckCommitment });
  state.deckCommitment = deckCommitment;
  state.encryptedHands = encryptedHands;

  res.json({
    deckCommitment,
    encryptedHands,
    proof
  });
});

app.post("/api/verify-hand", (req, res) => {
  const { deckCommitment, encryptedHand, proof } = req.body;
  const recomputed = createProofMock({ encryptedHand, deckCommitment });
  const verified = proof?.proof === recomputed.proof;
  res.json({ verified });
});

app.post("/api/face-verify", (req, res) => {
  const { embedding } = req.body;
  const normalized = String(embedding || "");
  if (!normalized) {
    res.status(400).json({ error: "missing embedding" });
    return;
  }
  const unique = !state.faceHashes.has(normalized);
  state.faceHashes.add(normalized);
  const now = Date.now();
  const player = state.players.get(normalized) || {
    hash: normalized,
    verified: false,
    lastSeen: now
  };
  player.verified = true;
  player.lastSeen = now;
  state.players.set(normalized, player);
  const proof = createProofMock({ embedding: normalized, unique });
  res.json({
    unique,
    proof,
    hash: normalized
  });
});

app.post("/api/join-table", (req, res) => {
  const { playerHash } = req.body;
  if (playerHash) {
    const now = Date.now();
    const player = state.players.get(playerHash) || {
      hash: playerHash,
      verified: false,
      lastSeen: now
    };
    player.lastSeen = now;
    state.players.set(playerHash, player);
  }
  res.json({ players: Array.from(state.players.values()) });
});

app.post("/api/register-key", (req, res) => {
  const { playerHash, playerKey } = req.body;
  if (playerHash && playerKey) {
    state.playerKeys.set(playerHash, playerKey);
    res.json({ ok: true });
    return;
  }
  res.status(400).json({ ok: false });
});

app.post("/api/liveness", (req, res) => {
  const { playerHash, embedding } = req.body;
  if (!playerHash || !embedding) {
    res.json({ alive: false });
    return;
  }
  const now = Date.now();
  const player = state.players.get(playerHash) || {
    hash: playerHash,
    verified: false,
    lastSeen: now
  };
  player.verified = true;
  player.lastSeen = now;
  state.players.set(playerHash, player);
  const proof = createProofMock({ embedding, liveness: true });
  res.json({ alive: true, proof });
});

app.post("/api/place-bet", (req, res) => {
  const { amount = 0 } = req.body;
  const parsed = Number(amount);
  state.pot += Number.isFinite(parsed) ? parsed : 0;
  res.json({ pot: state.pot });
});

app.post("/api/settle", (req, res) => {
  const { winnerIndex = 0, deckCommitment, encryptedHand, proof } = req.body;
  const recomputed = createProofMock({ encryptedHand, deckCommitment });
  const verified = proof?.proof === recomputed.proof;
  const playerList = Array.from(state.players.keys());
  const winner = playerList[winnerIndex] || "player-0";
  state.lastWinner = { winner, pot: state.pot, verified };
  state.pot = 0;
  res.json({
    verified,
    winner,
    paidOut: state.lastWinner.pot
  });
});

function getOrCreateGame(gameId) {
  const id = String(gameId || "").trim();
  if (!id) {
    return null;
  }
  if (!state.games.has(id)) {
    state.games.set(id, {
      id,
      players: [],
      pot: 0,
      phase: "waiting",
      currentTurnIndex: 0,
      lastAction: null,
      actionCount: 0,
      currentBet: 0,
      pendingActors: [],
      roundBets: new Map(),
      deck: [],
      community: [],
      revealedCount: 0,
      hands: new Map(),
      encryptedHands: new Map(),
      deckCommitment: null,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
  }
  return state.games.get(id);
}

function initializeGame(game) {
  const deck = shuffleDeck(buildDeck());
  const deckCommitment = poseidonHashMock(deck.join(","));
  const hands = new Map();
  const encryptedHands = new Map();
  game.players.forEach((player, index) => {
    const card1 = deck[index * 2];
    const card2 = deck[index * 2 + 1];
    hands.set(player.hash, [card1, card2]);
    const key = state.playerKeys.get(player.hash);
    if (key) {
      encryptedHands.set(player.hash, [
        encryptCardMock(card1, key),
        encryptCardMock(card2, key)
      ]);
    }
  });
  const community = deck.slice(game.players.length * 2, game.players.length * 2 + 5);
  game.deck = deck;
  game.deckCommitment = deckCommitment;
  game.community = community;
  game.revealedCount = 0;
  game.hands = hands;
  game.encryptedHands = encryptedHands;
  game.phase = "preflop";
  game.actionCount = 0;
  game.currentBet = 0;
  game.roundBets = new Map();
  game.pendingActors = game.players.map((player) => player.hash);
}

function ensureEncryptedHand(game, playerHash) {
  if (game.encryptedHands.has(playerHash)) {
    return true;
  }
  const playerIndex = game.players.findIndex(
    (player) => player.hash === playerHash
  );
  if (playerIndex === -1) {
    return false;
  }
  const key = state.playerKeys.get(playerHash);
  if (!key || !game.deck.length) {
    return false;
  }
  const card1 = game.deck[playerIndex * 2];
  const card2 = game.deck[playerIndex * 2 + 1];
  game.encryptedHands.set(playerHash, [
    encryptCardMock(card1, key),
    encryptCardMock(card2, key)
  ]);
  return true;
}

function advancePhase(game) {
  if (game.revealedCount === 0) {
    game.revealedCount = 3;
    game.phase = "flop";
  } else if (game.revealedCount === 3) {
    game.revealedCount = 4;
    game.phase = "turn";
  } else if (game.revealedCount === 4) {
    game.revealedCount = 5;
    game.phase = "river";
  } else if (game.revealedCount >= 5) {
    game.phase = "showdown";
  }
}

function serializeGame(game) {
  const revealedHands =
    game.phase === "showdown"
      ? Object.fromEntries(game.hands.entries())
      : null;
  return {
    id: game.id,
    players: game.players,
    pot: game.pot,
    phase: game.phase,
    currentTurnIndex: game.currentTurnIndex,
    lastAction: game.lastAction,
    winner: game.winner || null,
    community: game.community.slice(0, game.revealedCount),
    deckCommitment: game.deckCommitment,
    currentBet: game.currentBet,
    pendingActors: game.pendingActors,
    revealedHands
  };
}

function startRound(game) {
  const activeHashes = game.players
    .filter((player) => !player.folded)
    .map((player) => player.hash);
  game.pendingActors = activeHashes;
  game.currentBet = 0;
  game.roundBets = new Map();
}

function removePending(game, playerHash) {
  game.pendingActors = game.pendingActors.filter((hash) => hash !== playerHash);
}

function nextActiveIndex(players, startIndex) {
  if (!players.length) {
    return 0;
  }
  for (let i = 1; i <= players.length; i += 1) {
    const idx = (startIndex + i) % players.length;
    if (!players[idx].folded) {
      return idx;
    }
  }
  return startIndex;
}

app.post("/api/game/join", (req, res) => {
  const { gameId, playerHash } = req.body;
  const game = getOrCreateGame(gameId);
  if (!game) {
    res.status(400).json({ error: "missing gameId" });
    return;
  }
  if (!playerHash) {
    res.status(400).json({ error: "missing playerHash" });
    return;
  }
  const existing = game.players.find((player) => player.hash === playerHash);
  if (!existing) {
    game.players.push({
      hash: playerHash,
      folded: false,
      stack: 100,
      lastAction: null
    });
  }
  if (game.players.length >= 2 && game.phase === "waiting") {
    initializeGame(game);
    game.currentTurnIndex = 0;
  }
  game.updatedAt = Date.now();
  res.json({ game: serializeGame(game) });
});

app.get("/api/game/status", (req, res) => {
  const { gameId } = req.query;
  const game = getOrCreateGame(gameId);
  if (!game) {
    res.status(400).json({ error: "missing gameId" });
    return;
  }
  res.json({ game: serializeGame(game) });
});

app.post("/api/game/action", (req, res) => {
  const { gameId, playerHash, action, amount = 0 } = req.body;
  const game = getOrCreateGame(gameId);
  if (!game) {
    res.status(400).json({ error: "missing gameId" });
    return;
  }
  const playerIndex = game.players.findIndex(
    (player) => player.hash === playerHash
  );
  if (playerIndex === -1) {
    res.status(400).json({ error: "player not in game" });
    return;
  }
  const pendingSet = new Set(game.pendingActors);
  const isPending = pendingSet.has(playerHash);
  const isTurn =
    game.players[game.currentTurnIndex]?.hash === playerHash ||
    !game.players[game.currentTurnIndex];
  if (!isTurn && !isPending) {
    res.status(400).json({ error: "not your turn" });
    return;
  }
  if (!isTurn && isPending) {
    game.currentTurnIndex = playerIndex;
  }

  const parsedAmount = Number(amount);
  const safeAmount = Number.isFinite(parsedAmount) ? parsedAmount : 0;
  const player = game.players[playerIndex];

  if (action === "fold") {
    player.folded = true;
    player.lastAction = "fold";
    removePending(game, playerHash);
  } else if (action === "check") {
    if (game.currentBet > 0) {
      res.status(400).json({ error: "cannot check" });
      return;
    }
    player.lastAction = "check";
    removePending(game, playerHash);
  } else if (action === "call") {
    const prev = game.roundBets.get(playerHash) || 0;
    const required = Math.max(game.currentBet - prev, 0);
    if (safeAmount !== required) {
      res.status(400).json({ error: "call amount must match bet" });
      return;
    }
    if (required === 0) {
      player.lastAction = "check";
    } else {
      game.pot += required;
      game.roundBets.set(playerHash, prev + required);
      player.lastAction = `call ${required}`;
    }
    removePending(game, playerHash);
  } else if (action === "raise") {
    if (safeAmount <= game.currentBet) {
      res.status(400).json({ error: "raise too small" });
      return;
    }
    const prev = game.roundBets.get(playerHash) || 0;
    const delta = safeAmount - prev;
    game.pot += delta;
    game.currentBet = safeAmount;
    game.roundBets.set(playerHash, safeAmount);
    player.lastAction = `raise ${safeAmount}`;
    const activeHashes = game.players
      .filter((p) => !p.folded)
      .map((p) => p.hash)
      .filter((hash) => hash !== playerHash);
    game.pendingActors = activeHashes;
  } else {
    res.status(400).json({ error: "invalid action" });
    return;
  }

  game.lastAction = {
    player: playerHash,
    action,
    amount: safeAmount
  };
  game.actionCount += 1;

  const activePlayers = game.players.filter((p) => !p.folded);
  if (activePlayers.length <= 1) {
    game.phase = "showdown";
    game.winner = activePlayers[0]?.hash || null;
  } else {
    game.currentTurnIndex = nextActiveIndex(game.players, game.currentTurnIndex);
    if (game.pendingActors.length === 0) {
      advancePhase(game);
      if (game.phase === "showdown") {
        if (!game.winner) {
          game.winner = activePlayers[0]?.hash || null;
        }
      } else {
        startRound(game);
        game.currentTurnIndex = nextActiveIndex(game.players, -1);
      }
    }
  }

  game.updatedAt = Date.now();
  res.json({ game: serializeGame(game) });
});

app.get("/api/game/hand", (req, res) => {
  const { gameId, playerHash } = req.query;
  const game = getOrCreateGame(gameId);
  if (!game) {
    res.status(400).json({ error: "missing gameId" });
    return;
  }
  if (!playerHash) {
    res.status(400).json({ error: "missing playerHash" });
    return;
  }
  if (!game.deckCommitment) {
    if (game.players.length < 2) {
      res.status(409).json({ error: "waiting for players" });
      return;
    }
    initializeGame(game);
  }
  const hasHand = ensureEncryptedHand(game, playerHash);
  if (!hasHand) {
    res.status(404).json({ error: "hand not ready" });
    return;
  }
  const encrypted = game.encryptedHands.get(playerHash);
  const proof = createProofMock({
    encryptedHand: { playerHash, cards: encrypted },
    deckCommitment: game.deckCommitment
  });
  res.json({
    deckCommitment: game.deckCommitment,
    encryptedHand: { playerHash, cards: encrypted },
    proof
  });
});

app.listen(port, () => {
  console.log(`ZK LivePoker MVP running on http://localhost:${port}`);
});
