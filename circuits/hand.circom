pragma circom 2.1.6;

// MVP placeholder: prove encrypted hand is from committed deck.
// Replace Poseidon with circomlib poseidon when productionizing.

template HandInDeck() {
    signal input deckCommitment;
    signal input encryptedHand;
    signal output ok;

    // Placeholder constraint for demo purposes.
    ok <== deckCommitment * 0 + encryptedHand * 0 + 1;
}

component main = HandInDeck();
