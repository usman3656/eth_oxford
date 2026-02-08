const hre = require("hardhat");

async function main() {
  const LivePoker = await hre.ethers.getContractFactory("LivePoker");
  const livePoker = await LivePoker.deploy();
  await livePoker.waitForDeployment();
  console.log("LivePoker deployed to:", await livePoker.getAddress());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
