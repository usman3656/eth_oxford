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

const RANK_VALUES = {
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  "6": 6,
  "7": 7,
  "8": 8,
  "9": 9,
  "10": 10,
  J: 11,
  Q: 12,
  K: 13,
  A: 14
};

function parseCard(card) {
  const trimmed = String(card || "").trim();
  const suit = trimmed.slice(-1);
  const rank = trimmed.slice(0, -1);
  return {
    rank,
    rankValue: RANK_VALUES[rank] || 0,
    suit
  };
}

function getStraightHigh(ranks) {
  const unique = Array.from(new Set(ranks)).sort((a, b) => a - b);
  if (unique.includes(14)) {
    unique.unshift(1);
  }
  let streak = 1;
  let bestHigh = null;
  for (let i = 1; i < unique.length; i += 1) {
    if (unique[i] === unique[i - 1] + 1) {
      streak += 1;
    } else if (unique[i] !== unique[i - 1]) {
      streak = 1;
    }
    if (streak >= 5) {
      bestHigh = unique[i];
    }
  }
  return bestHigh;
}

function evaluateFive(cards) {
  const parsed = cards.map(parseCard);
  const ranks = parsed.map((c) => c.rankValue).sort((a, b) => b - a);
  const suits = parsed.map((c) => c.suit);
  const isFlush = suits.every((suit) => suit === suits[0]);
  const straightHigh = getStraightHigh(ranks);

  const counts = new Map();
  for (const rank of ranks) {
    counts.set(rank, (counts.get(rank) || 0) + 1);
  }
  const groups = Array.from(counts.entries()).sort((a, b) => {
    if (b[1] !== a[1]) {
      return b[1] - a[1];
    }
    return b[0] - a[0];
  });
  const ranksByCount = groups.map(([rank, count]) => ({ rank, count }));
  const triples = ranksByCount.filter((g) => g.count === 3).map((g) => g.rank);
  const pairs = ranksByCount.filter((g) => g.count === 2).map((g) => g.rank);

  if (isFlush && straightHigh) {
    if (straightHigh === 14) {
      return { rank: 9, tiebreaker: [14] };
    }
    return { rank: 8, tiebreaker: [straightHigh] };
  }
  if (ranksByCount[0]?.count === 4) {
    const quad = ranksByCount[0].rank;
    const kicker = ranks.find((r) => r !== quad);
    return { rank: 7, tiebreaker: [quad, kicker] };
  }
  if (triples.length >= 1 && (pairs.length >= 1 || triples.length >= 2)) {
    const triple = triples[0];
    const pair = pairs[0] || triples[1];
    return { rank: 6, tiebreaker: [triple, pair] };
  }
  if (isFlush) {
    return { rank: 5, tiebreaker: [...ranks] };
  }
  if (straightHigh) {
    return { rank: 4, tiebreaker: [straightHigh] };
  }
  if (triples.length >= 1) {
    const triple = triples[0];
    const kickers = ranks.filter((r) => r !== triple).slice(0, 2);
    return { rank: 3, tiebreaker: [triple, ...kickers] };
  }
  if (pairs.length >= 2) {
    const [highPair, lowPair] = pairs.sort((a, b) => b - a);
    const kicker = ranks.find((r) => r !== highPair && r !== lowPair);
    return { rank: 2, tiebreaker: [highPair, lowPair, kicker] };
  }
  if (pairs.length === 1) {
    const pair = pairs[0];
    const kickers = ranks.filter((r) => r !== pair).slice(0, 3);
    return { rank: 1, tiebreaker: [pair, ...kickers] };
  }
  return { rank: 0, tiebreaker: [...ranks] };
}

function compareHands(a, b) {
  if (a.rank !== b.rank) {
    return a.rank - b.rank;
  }
  const len = Math.max(a.tiebreaker.length, b.tiebreaker.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (a.tiebreaker[i] || 0) - (b.tiebreaker[i] || 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

function bestHandFromSeven(cards) {
  let best = null;
  for (let a = 0; a < cards.length - 4; a += 1) {
    for (let b = a + 1; b < cards.length - 3; b += 1) {
      for (let c = b + 1; c < cards.length - 2; c += 1) {
        for (let d = c + 1; d < cards.length - 1; d += 1) {
          for (let e = d + 1; e < cards.length; e += 1) {
            const hand = evaluateFive([cards[a], cards[b], cards[c], cards[d], cards[e]]);
            if (!best || compareHands(hand, best) > 0) {
              best = hand;
            }
          }
        }
      }
    }
  }
  return best;
}

function determineWinners(game) {
  const community = game.community.slice(0, 5);
  const contenders = game.players.filter((p) => !p.folded);
  let best = null;
  let winners = [];
  for (const player of contenders) {
    const hand = game.hands.get(player.hash);
    if (!hand || hand.length < 2 || community.length < 5) {
      continue;
    }
    const evaluation = bestHandFromSeven([...hand, ...community]);
    if (!best || compareHands(evaluation, best) > 0) {
      best = evaluation;
      winners = [player.hash];
    } else if (best && compareHands(evaluation, best) === 0) {
      winners.push(player.hash);
    }
  }
  return { winners, best };
}

function buildDeck() {
  const suits = ["♠", "♥", "♦", "♣"];
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
      dealerIndex: 0,
      smallBlind: 5,
      bigBlind: 10,
      handNumber: 0,
      lastAction: null,
      actionCount: 0,
      currentBet: 0,
      pendingActors: [],
      roundBets: new Map(),
      roundActions: new Set(),
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
  game.handNumber += 1;
  if (game.handNumber === 1) {
    game.dealerIndex = 0;
  } else {
    game.dealerIndex = nextActiveIndex(game.players, game.dealerIndex);
  }
  game.pot = 0;
  game.winner = null;
  game.players.forEach((player) => {
    player.folded = false;
    player.lastAction = null;
  });
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
  game.currentBet = game.bigBlind;
  game.roundBets = new Map();
  game.roundActions = new Set();
  const sbIndex = nextActiveIndex(game.players, game.dealerIndex);
  const bbIndex = nextActiveIndex(game.players, sbIndex);
  const sbPlayer = game.players[sbIndex];
  const bbPlayer = game.players[bbIndex];
  if (sbPlayer) {
    game.pot += game.smallBlind;
    game.roundBets.set(sbPlayer.hash, game.smallBlind);
    sbPlayer.stack = Math.max(0, (sbPlayer.stack ?? 100) - game.smallBlind);
    sbPlayer.lastAction = `blind ${game.smallBlind}`;
  }
  if (bbPlayer) {
    game.pot += game.bigBlind;
    game.roundBets.set(bbPlayer.hash, game.bigBlind);
    bbPlayer.stack = Math.max(0, (bbPlayer.stack ?? 100) - game.bigBlind);
    bbPlayer.lastAction = `blind ${game.bigBlind}`;
  }
  const startIndex = nextActiveIndex(game.players, bbIndex);
  setPendingActors(game, startIndex);
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

function createBot(game) {
  const botId = `bot-${game.players.filter((p) => p.isBot).length + 1}`;
  return {
    hash: botId,
    folded: false,
    stack: 100,
    lastAction: null,
    isBot: true
  };
}

function handleAction(game, playerHash, action, amount = 0) {
  const playerIndex = game.players.findIndex(
    (player) => player.hash === playerHash
  );
  if (playerIndex === -1) {
    return "player not in game";
  }
  const isTurn = game.players[game.currentTurnIndex]?.hash === playerHash;
  if (!isTurn) {
    return "not your turn";
  }

  const parsedAmount = Number(amount);
  const safeAmount = Number.isFinite(parsedAmount) ? parsedAmount : 0;
  const player = game.players[playerIndex];
  const prev = game.roundBets.get(playerHash) || 0;
  const required = Math.max(game.currentBet - prev, 0);

  if (action === "fold") {
    player.folded = true;
    player.lastAction = "fold";
    removePending(game, playerHash);
  } else if (action === "check") {
    if (required > 0) {
      return "cannot check";
    }
    player.lastAction = "check";
    removePending(game, playerHash);
  } else if (action === "call") {
    const callAmount = safeAmount === 0 ? required : safeAmount;
    if (callAmount < required) {
      return "call amount must match bet";
    }
    if (required === 0) {
      player.lastAction = "check";
    } else {
      game.pot += required;
      game.roundBets.set(playerHash, prev + required);
      player.stack = Math.max(0, (player.stack ?? 100) - required);
      player.lastAction = `call ${required}`;
    }
    removePending(game, playerHash);
  } else if (action === "raise") {
    if (safeAmount <= game.currentBet) {
      return "raise too small";
    }
    const delta = safeAmount - prev;
    if (delta <= required) {
      return "raise too small";
    }
    game.pot += delta;
    game.currentBet = safeAmount;
    game.roundBets.set(playerHash, safeAmount);
    player.stack = Math.max(0, (player.stack ?? 100) - delta);
    player.lastAction = `raise ${safeAmount}`;
    const activeHashes = game.players
      .filter((p) => !p.folded)
      .map((p) => p.hash)
      .filter((hash) => hash !== playerHash);
    game.pendingActors = activeHashes;
    game.roundActions = new Set([playerHash]);
  } else {
    return "invalid action";
  }

  game.roundActions.add(playerHash);
  game.lastAction = {
    player: playerHash,
    action,
    amount: safeAmount
  };
  game.actionCount += 1;

  const activePlayers = game.players.filter((p) => !p.folded);
  if (activePlayers.length <= 1) {
    game.phase = "showdown";
    game.revealedCount = 5;
    game.winner = activePlayers[0]?.hash || null;
  } else {
    game.currentTurnIndex = nextActiveIndex(game.players, game.currentTurnIndex);
    if (isBettingRoundComplete(game)) {
      advancePhase(game);
      if (game.phase === "showdown") {
        game.revealedCount = 5;
        const result = determineWinners(game);
        game.winner = result.winners.length
          ? result.winners.join(", ")
          : activePlayers[0]?.hash || null;
      } else {
        const startIndex = nextActiveIndex(game.players, game.dealerIndex);
        startRound(game, startIndex);
      }
    }
  }

  game.updatedAt = Date.now();
  return null;
}

function runBotTurns(game) {
  let safety = 0;
  while (safety < 10) {
    safety += 1;
    const current = game.players[game.currentTurnIndex];
    if (!current || !current.isBot) {
      break;
    }
    if (!game.pendingActors.includes(current.hash)) {
      break;
    }
    const prev = game.roundBets.get(current.hash) || 0;
    const required = Math.max(game.currentBet - prev, 0);
    const action = required > 0 ? "call" : "check";
    const error = handleAction(game, current.hash, action, required);
    if (error) {
      break;
    }
    if (game.phase === "showdown") {
      break;
    }
  }
}

function setPendingActors(game, startIndex) {
  const activeHashes = [];
  if (game.players.length) {
    for (let i = 0; i < game.players.length; i += 1) {
      const idx = (startIndex + i) % game.players.length;
      const player = game.players[idx];
      if (player && !player.folded) {
        activeHashes.push(player.hash);
      }
    }
  }
  game.pendingActors = activeHashes;
  game.currentTurnIndex =
    activeHashes.length > 0
      ? game.players.findIndex((p) => p.hash === activeHashes[0])
      : game.currentTurnIndex;
}

function startRound(game, startIndex) {
  game.currentBet = 0;
  game.roundBets = new Map();
  game.roundActions = new Set();
  setPendingActors(game, startIndex);
}

function isBettingRoundComplete(game) {
  const active = game.players.filter((p) => !p.folded);
  if (!active.length) {
    return true;
  }
  const allActed = active.every((p) => game.roundActions.has(p.hash));
  if (game.currentBet === 0) {
    return allActed;
  }
  const allMatched = active.every(
    (p) => (game.roundBets.get(p.hash) || 0) >= game.currentBet
  );
  return allActed && allMatched;
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
    if (game.phase !== "waiting") {
      res.status(409).json({ error: "game already started" });
      return;
    }
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
  const error = handleAction(game, playerHash, action, amount);
  if (error) {
    res.status(400).json({ error });
    return;
  }
  runBotTurns(game);
  res.json({ game: serializeGame(game) });
});

app.post("/api/game/bots/add", (req, res) => {
  const { gameId, count = 1 } = req.body;
  const game = getOrCreateGame(gameId);
  if (!game) {
    res.status(400).json({ error: "missing gameId" });
    return;
  }
  const addCount = Math.max(1, Math.min(Number(count) || 1, 4));
  for (let i = 0; i < addCount; i += 1) {
    game.players.push(createBot(game));
  }
  if (game.players.length >= 2 && game.phase === "waiting") {
    initializeGame(game);
    game.currentTurnIndex = 0;
  }
  runBotTurns(game);
  game.updatedAt = Date.now();
  res.json({ game: serializeGame(game) });
});

app.post("/api/game/bots/remove", (req, res) => {
  const { gameId, count = 1 } = req.body;
  const game = getOrCreateGame(gameId);
  if (!game) {
    res.status(400).json({ error: "missing gameId" });
    return;
  }
  const removeCount = Math.max(1, Math.min(Number(count) || 1, 4));
  for (let i = 0; i < removeCount; i += 1) {
    const idx = [...game.players]
      .reverse()
      .findIndex((p) => p.isBot);
    if (idx === -1) {
      break;
    }
    const removeIndex = game.players.length - 1 - idx;
    const removed = game.players.splice(removeIndex, 1)[0];
    if (removed) {
      game.pendingActors = game.pendingActors.filter((h) => h !== removed.hash);
      game.roundBets.delete(removed.hash);
      game.hands.delete(removed.hash);
      game.encryptedHands.delete(removed.hash);
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
