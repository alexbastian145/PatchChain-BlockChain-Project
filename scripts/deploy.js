const hre = require("hardhat");

const num = (name, fallback) => (process.env[name] ? Number(process.env[name]) : fallback);

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying contracts with account:", deployer.address);

  const { parseEther } = hre.ethers;
  const REQUIRED_STAKE = parseEther("0.01"); // base researcher stake (discounted by reputation)
  const DISCLOSURE_WINDOW = 90 * 24 * 60 * 60; // 90 days, in seconds

  // Arbitration court parameters. Override the periods for a quick demo, e.g.
  //   COURT_EVIDENCE_SECONDS=120 COURT_COMMIT_SECONDS=120 COURT_REVEAL_SECONDS=120
  const COURT = {
    panelSize: num("COURT_PANEL_SIZE", 3),
    jurorDeposit: parseEther(process.env.COURT_JUROR_DEPOSIT || "0.05"),
    caseLock: parseEther(process.env.COURT_CASE_LOCK || "0.02"),
    fee: parseEther(process.env.COURT_FEE || "0.01"),
    evidence: num("COURT_EVIDENCE_SECONDS", 24 * 60 * 60),
    commit: num("COURT_COMMIT_SECONDS", 24 * 60 * 60),
    reveal: num("COURT_REVEAL_SECONDS", 24 * 60 * 60),
  };

  async function deploy(name, args = []) {
    const factory = await hre.ethers.getContractFactory(name);
    const contract = await factory.deploy(...args);
    await contract.waitForDeployment();
    console.log(`${name} deployed to:`, await contract.getAddress());
    return contract;
  }

  // 1-4. Core protocol
  const registry = await deploy("VulnerabilityRegistry");
  const stakeManager = await deploy("StakeManager", [await registry.getAddress(), REQUIRED_STAKE]);
  // The deployer is the temporary arbitrator; the court takes over below.
  const escrow = await deploy("BountyEscrow", [await registry.getAddress(), deployer.address]);
  const timer = await deploy("DisclosureTimer", [
    await registry.getAddress(),
    await escrow.getAddress(),
    DISCLOSURE_WINDOW,
  ]);

  // 5-7. Extensions: end-to-end-encryption keys, soulbound reputation, decentralized arbitration
  const keyRegistry = await deploy("KeyRegistry");
  const reputation = await deploy("ReputationNFT");
  const court = await deploy("ArbitrationCourt", [
    await escrow.getAddress(),
    await keyRegistry.getAddress(),
    COURT.panelSize,
    COURT.jurorDeposit,
    COURT.caseLock,
    COURT.fee,
    COURT.evidence,
    COURT.commit,
    COURT.reveal,
  ]);

  // Wiring
  const steps = [
    ["Registry linked to StakeManager, BountyEscrow and DisclosureTimer", () =>
      registry.setLinkedContracts(
        stakeManager.getAddress(),
        escrow.getAddress(),
        timer.getAddress()
      )],
    ["BountyEscrow arbitrator set to ArbitrationCourt", async () =>
      escrow.setArbitrator(await court.getAddress())],
    ["BountyEscrow -> ReputationNFT", async () =>
      escrow.setReputation(await reputation.getAddress())],
    ["StakeManager -> ReputationNFT", async () =>
      stakeManager.setReputation(await reputation.getAddress())],
    ["ReputationNFT recorder: BountyEscrow", async () =>
      reputation.setRecorder(await escrow.getAddress(), true)],
    ["ReputationNFT recorder: StakeManager", async () =>
      reputation.setRecorder(await stakeManager.getAddress(), true)],
  ];
  for (const [label, send] of steps) {
    const tx = await send();
    await tx.wait();
    console.log(label + ".");
  }

  const addresses = {
    VulnerabilityRegistry: await registry.getAddress(),
    StakeManager: await stakeManager.getAddress(),
    BountyEscrow: await escrow.getAddress(),
    DisclosureTimer: await timer.getAddress(),
    KeyRegistry: await keyRegistry.getAddress(),
    ReputationNFT: await reputation.getAddress(),
    ArbitrationCourt: await court.getAddress(),
  };

  console.log("\nDeployment summary:");
  console.log({
    ...addresses,
    requiredStakeWei: REQUIRED_STAKE.toString(),
    disclosureWindowSeconds: DISCLOSURE_WINDOW,
    court: {
      panelSize: COURT.panelSize,
      jurorDepositWei: COURT.jurorDeposit.toString(),
      caseLockWei: COURT.caseLock.toString(),
      feeWei: COURT.fee.toString(),
      evidenceSeconds: COURT.evidence,
      commitSeconds: COURT.commit,
      revealSeconds: COURT.reveal,
    },
  });

  console.log("\n# Paste into backend/.env");
  console.log(`REGISTRY_ADDRESS=${addresses.VulnerabilityRegistry}`);
  console.log(`STAKE_MANAGER_ADDRESS=${addresses.StakeManager}`);
  console.log(`ESCROW_ADDRESS=${addresses.BountyEscrow}`);
  console.log(`DISCLOSURE_TIMER_ADDRESS=${addresses.DisclosureTimer}`);

  console.log("\n# Paste into frontend/.env");
  console.log(`VITE_REGISTRY_ADDRESS=${addresses.VulnerabilityRegistry}`);
  console.log(`VITE_STAKE_MANAGER_ADDRESS=${addresses.StakeManager}`);
  console.log(`VITE_ESCROW_ADDRESS=${addresses.BountyEscrow}`);
  console.log(`VITE_DISCLOSURE_TIMER_ADDRESS=${addresses.DisclosureTimer}`);
  console.log(`VITE_KEY_REGISTRY_ADDRESS=${addresses.KeyRegistry}`);
  console.log(`VITE_REPUTATION_ADDRESS=${addresses.ReputationNFT}`);
  console.log(`VITE_COURT_ADDRESS=${addresses.ArbitrationCourt}`);

  return addresses;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { main };
