// Copies compiled contract artifacts into the frontend so its ABIs always match the
// contracts that were actually deployed. Run after every compile:
//   node scripts/solc-build.js && node scripts/export-abis.js
const fs = require("fs");
const path = require("path");

const CONTRACTS = [
  "VulnerabilityRegistry",
  "StakeManager",
  "BountyEscrow",
  "DisclosureTimer",
  "KeyRegistry",
  "ReputationNFT",
  "ArbitrationCourt",
];

const artifactsDir = path.join(__dirname, "..", "artifacts", "contracts");
const outDir = path.join(__dirname, "..", "frontend", "src", "abis");
fs.mkdirSync(outDir, { recursive: true });

for (const name of CONTRACTS) {
  const source = path.join(artifactsDir, `${name}.sol`, `${name}.json`);
  if (!fs.existsSync(source)) {
    console.error(`Missing artifact for ${name}. Compile first.`);
    process.exit(1);
  }
  const artifact = JSON.parse(fs.readFileSync(source, "utf8"));
  // The frontend only needs the ABI, so skip the (large) bytecode.
  const slim = { _format: artifact._format, contractName: artifact.contractName, abi: artifact.abi };
  fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(slim, null, 2) + "\n");
  console.log(`exported ${name}`);
}
