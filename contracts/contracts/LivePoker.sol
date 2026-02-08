// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

contract LivePoker {
    struct TableState {
        uint256 pot;
        address lastWinner;
    }

    mapping(bytes32 => bool) public joinedPlayers;
    TableState public table;

    event Joined(bytes32 indexed playerHash);
    event BetPlaced(address indexed player, uint256 amount, uint256 pot);
    event Settled(address indexed winner, uint256 payout, bytes proof);

    function joinTable(bytes32 playerHash) external {
        require(playerHash != bytes32(0), "invalid hash");
        require(!joinedPlayers[playerHash], "already joined");
        joinedPlayers[playerHash] = true;
        emit Joined(playerHash);
    }

    function placeBet() external payable {
        require(msg.value > 0, "no bet");
        table.pot += msg.value;
        emit BetPlaced(msg.sender, msg.value, table.pot);
    }

    function settleHand(address winner, bytes calldata proof) external {
        require(winner != address(0), "invalid winner");
        require(proof.length > 0, "invalid proof");

        uint256 payout = table.pot;
        table.pot = 0;
        table.lastWinner = winner;

        (bool sent, ) = winner.call{ value: payout }("");
        require(sent, "payout failed");
        emit Settled(winner, payout, proof);
    }
}
