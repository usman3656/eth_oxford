pragma circom 2.1.6;

// MVP placeholder: prove embedding hash is unique.
// Replace with proper uniqueness check against a set commitment.

template FaceUnique() {
    signal input embedding;
    signal input usedHash;
    signal output unique;

    // Placeholder constraint for demo purposes.
    unique <== embedding * 0 + usedHash * 0 + 1;
}

component main = FaceUnique();
