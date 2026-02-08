# ZK-LivePoker MVP

ZK-LivePoker is a multiplayer Texas Hold'em demo that combines verifiable
dealing, human liveness checks, and a minimal on-chain betting contract.
It is designed as a hackathon-ready prototype with a clear, judge-friendly
flow that highlights cryptography concepts while keeping gameplay fast.

## What this project demonstrates

- Verifiable dealing flow (mocked ZK proof for deck commitment + hands)
- Human presence and uniqueness checks using webcam face detection
- Multiplayer game state with turn-based actions and phases
- A minimal Ethereum smart contract for join/bet/settle events

## ZK and blockchain: purpose and tech

ZK (Zero-Knowledge)
- Purpose:
  - Prove the deck was committed and hands are valid without revealing secrets
  - Prove a real human is present without sending raw biometrics
- Tech used in this repo:
  - Mocked ZK: `backend/zk.js` uses SHA-256 to simulate proofs
  - Placeholder circuits: `circuits/hand.circom`, `circuits/face.circom`
  - Intended stack: Circom + snarkjs (not fully wired yet)

Blockchain
- Purpose:
  - Make join/bet/settle events auditable and tamper resistant
- Tech used in this repo:
  - Solidity contract `contracts/contracts/LivePoker.sol`
  - Hardhat local chain and deploy script

## How the demo works

1. Users join the same game ID from different tabs/devices.
2. Webcam-based liveness runs; the first verified face becomes the benchmark.
3. The backend shuffles a deck, commits to it, and deals encrypted hands.
4. Players take turns (fold/check/call/raise). Community cards reveal by phase.
5. On showdown, hands are evaluated and the winner is determined.

The ZK and blockchain steps are currently mocked or minimal but included to
show how the final system would be wired.

## Run the demo

1. Start backend (serves frontend too)
```
cd backend
npm install
npm start
```

2. Open browser
```
http://localhost:3000
```

## Optional: smart contract demo

1. Start local chain
```
cd contracts
npm install
npx hardhat node
```

2. Deploy
```
npm run deploy
```

## Project structure

- `frontend/` UI, webcam, face checks, and multiplayer polling
- `backend/` Express server with game state and mock ZK helpers
- `contracts/` Hardhat + Solidity contract
- `circuits/` Placeholder Circom circuits

## Key endpoints (backend)

- `POST /api/shuffle` deck commitment + encrypted hands
- `POST /api/verify-hand` verify a mock proof
- `POST /api/face-verify` register a unique face hash
- `POST /api/liveness` periodic liveness checks
- `POST /api/game/join` join a game by ID
- `GET /api/game/status` poll game state
- `POST /api/game/action` fold/check/call/raise
- `GET /api/game/hand` fetch encrypted hand for a player

## What is mocked

- Poseidon hash is simulated with SHA-256
- ZK proof is simulated by hashing inputs
- Hand encryption is base64-encoded payload

These are placeholders to show UX and protocol flow.

## Known limitations

- No real ZK proof generation/verification yet
- No real on-chain settlement or wallet integration
- No WebRTC streams for other players (UI placeholders only)

## Next steps

- Replace mocked proofs with Circom + snarkjs
- Add wallet flow and on-chain settlement
- Implement real-time player video streams
