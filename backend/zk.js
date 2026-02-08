import crypto from "crypto";

export function poseidonHashMock(input) {
  return crypto.createHash("sha256").update(String(input)).digest("hex");
}

export function encryptCardMock(card, playerKey) {
  const payload = `${card}|${playerKey}`;
  return Buffer.from(payload, "utf8").toString("base64url");
}

export function createProofMock(payload) {
  const digest = poseidonHashMock(JSON.stringify(payload));
  return {
    proof: `proof_${digest.slice(0, 16)}`,
    publicSignals: {
      commitment: digest.slice(0, 32)
    }
  };
}
