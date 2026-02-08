# ZK-LivePoker MVP

Quick demo showing:
- ZK-dealt hands (mock Poseidon proof)
- Webcam-based human uniqueness (hashed frames)
- Simple bet + settlement flow

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

## What is mocked
- Poseidon hash is simulated with SHA-256
- ZK proof is simulated by hashing inputs
- Hand encryption is base64-encoded payload

These are placeholders to show the UX and flow.

## Circuits (placeholders)
- `circuits/hand.circom`
- `circuits/face.circom`
