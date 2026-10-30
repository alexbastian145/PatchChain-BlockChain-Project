# PatchChain

A blockchain-based framework for decentralized vulnerability disclosure and
automated bug bounty payouts.

## Project Structure

```
patchchain/
├── contracts/                      Solidity smart contracts
│   ├── VulnerabilityRegistry.sol   Hashed, timestamped report submissions
│   ├── StakeManager.sol            Researcher stake / refund / forfeit (reputation-discounted)
│   ├── BountyEscrow.sol            Severity-tiered payouts + dispute hand-off
│   ├── DisclosureTimer.sol         Auto-disclosure after deadline + on-chain key release
│   ├── KeyRegistry.sol             Public directory of end-to-end-encryption keys
│   ├── ReputationNFT.sol           Soulbound researcher badge, scored on-chain
│   └── ArbitrationCourt.sol        Staked jury, commit-reveal voting, slashing
├── scripts/
│   ├── deploy.js            Deploys and wires up all 7 contracts, prints .env blocks
│   ├── export-abis.js       Copies compiled ABIs into the frontend
│   ├── gas-report.js        Prints gas cost for every major operation
│   └── solc-build.js        Manual compile step (see note below)
├── test/
│   ├── patchchain.test.js   Core lifecycle tests
│   ├── extensions.test.js   Key registry, reputation NFT, court, disclosure key
│   └── e2e.test.js          Real encryption module driving the real contracts
├── backend/                 Node/Express ciphertext relay: IPFS pinning + chain queries
│   └── src/
│       ├── routes/          reports.js, ipfs.js, queries.js
│       ├── utils/           ipfs.js, contracts.js
│       └── server.js
└── frontend/                React + Vite + ethers.js dApp
    └── src/
        ├── components/      SubmitReport, MyReports, OrgDashboard, Reputation, Arbitration
        ├── utils/           e2ee.js (all encryption), useWallet, useCrypto, api, contracts
        └── config.js
```

## A note on compilation

This environment's network policy blocks `binaries.soliditylang.org`, which
Hardhat normally downloads the native `solc` compiler from. `scripts/solc-build.js`
works around this by using the `solc` **npm package** (the WASM build, installed
from the regular npm registry) and writing output directly in Hardhat's artifact
JSON format. On a normal machine with unrestricted internet access, you can
ignore this and just run `npx hardhat compile` as usual — both approaches
produce equivalent artifacts.

```bash
# If `npx hardhat compile` fails in a restricted network environment:
node scripts/solc-build.js
```

## 1. Smart Contracts

```bash
npm install
node scripts/solc-build.js        # or: npx hardhat compile
npx hardhat test --no-compile     # 50 tests, all passing
node scripts/export-abis.js       # refresh the frontend's ABIs after any contract change

# Local testing
npx hardhat run scripts/deploy.js --no-compile --network hardhat
npx hardhat run scripts/gas-report.js --no-compile --network hardhat

# Testnet deployment (after filling in .env — see .env.example)
npx hardhat run scripts/deploy.js --no-compile --network sepolia
```

Copy `.env.example` to `.env` and fill in:
- `SEPOLIA_RPC_URL` — from Alchemy or Infura
- `PRIVATE_KEY` — a **throwaway testnet-only** wallet's private key
- `ETHERSCAN_API_KEY` — optional, for contract verification

### Contract addresses

`deploy.js` finishes by printing two ready-to-paste blocks, one for `backend/.env` and one
for `frontend/.env` (the frontend also needs the KeyRegistry, ReputationNFT and
ArbitrationCourt addresses). It also wires everything together: the court becomes the
escrow's arbitrator, and the escrow and stake manager become authorized reputation recorders.

## 2. Backend

```bash
cd backend
npm install
cp .env.example .env     # fill in RPC URL, private key, Pinata keys, contract addresses
node src/server.js       # runs on http://localhost:4000
```

Get free Pinata API keys at https://app.pinata.cloud (API Keys section).

### API endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/ipfs/pin` | Pins an **already-encrypted** envelope to IPFS; returns `{ cid, reportHash }`. Rejects anything that isn't a PatchChain ciphertext |
| GET | `/api/ipfs/:cid` | Returns the pinned ciphertext (base64) and its hash; the client verifies it against the on-chain hash |
| GET | `/api/reports/:id` | Report metadata from the registry (status, severity, payout state) |
| GET | `/api/organizations/:address/reports` | All reports addressed to an organization |
| GET | `/api/researchers/:address/reports` | All reports submitted by a researcher |
| GET | `/api/reports/:id/timer` | Disclosure countdown status |

The backend holds **no encryption key** and has no decrypt endpoint. See "Security model" below.

## 3. Frontend

```bash
cd frontend
npm install
cp .env.example .env     # fill in contract addresses + backend URL
npm run dev               # http://localhost:5173
```

Requires the MetaMask browser extension, connected to the same network
(Sepolia/Amoy/local Hardhat node) the contracts were deployed to.

## Lifecycle Walkthrough

1. **One-time setup.** The organization opens its dashboard and registers an encryption key
   (a free wallet signature derives it; it is published in `KeyRegistry`). It also sets its
   bounty tiers and funds the escrow.
2. **Researcher** fills out the Submit Report form. The browser looks up the organization's
   key, encrypts the report locally for the organization and the researcher, and sends only
   the ciphertext to the backend, which pins it to IPFS.
3. The researcher's own wallet calls `StakeManager.submitReportWithStake(...)`, recording the
   ciphertext's hash on-chain. The stake is 0.01 ETH, reduced by reputation rank.
4. **Organization** decrypts the report in its browser, picks a severity, and clicks
   **Approve & Pay**. `BountyEscrow` releases the payout and `ReputationNFT` credits the
   researcher automatically.
5. Organization clicks **Refund Researcher Stake**, or **Forfeit** for spam (which counts
   against the researcher's reputation).
6. If there is a disagreement, either party can **Raise Dispute**, then open a case in the
   **Arbitration** page (see below).
7. If the organization never acts, anyone can call `DisclosureTimer.triggerAutoDisclosure(...)`
   once the window (90 days by default) passes. The researcher can then publish the report's
   content key on-chain, and anyone can read the report.

## Security model

**End-to-end encryption.** Reports are encrypted in the browser (`frontend/src/utils/e2ee.js`,
NaCl: X25519 + XSalsa20-Poly1305). A random content key encrypts the report once, then is
"wrapped" separately for each reader. The backend and IPFS see only ciphertext and the backend
holds no key, so a compromised server cannot read a single report. Each user's keypair comes
from a wallet signature, so there is nothing to back up. The report's keccak256 is on-chain,
so any tampering with the IPFS copy is detected.

**Reputation (soulbound NFT).** Each researcher can claim one non-transferable badge
(ERC-721 + ERC-5192). Scores change automatically: Low +10, Medium +25, High +50, Critical +100,
rejected or spam -15. Rank sets the stake you post: Rookie 100%, Hunter (50+) 75%,
Elite (150+) 50%, Legend (400+) 25%. The badge image is generated fully on-chain.

**Decentralized arbitration.** Disputes go to `ArbitrationCourt` instead of one trusted account:

1. A party opens a case and pays a fee; a panel of 3 jurors is drawn from a staked pool
   (the parties are excluded) and each locks part of their deposit.
2. The party who holds the report re-wraps its content key for the drawn jurors, so only
   they can read it, and posts it as evidence.
3. Jurors vote with commit-reveal (hidden votes, so they cannot copy each other).
4. The majority is executed on the escrow: reject, or pay at the median severity chosen.
   Jurors who didn't reveal or voted against the majority are slashed; their stake plus the
   fee is shared among the jurors in the majority. A tie or no-show quorum voids the case
   and refunds the fee.

## ## Gas Costs (local Hardhat network, see `scripts/gas-report.js`)

| Operation | Gas Used |
|---|---|
| Deploy VulnerabilityRegistry | 955,406 |
| Deploy StakeManager | 918,129 |
| Deploy BountyEscrow | 1,274,726 |
| Deploy DisclosureTimer | 818,732 |
| submitReportWithStake | 221,620 |
| approveAndPay | 119,102 |
| refundStake | 61,528 |

## Known limitations / next steps

- Report queries (`/api/organizations/:address/reports`) scan event logs —
  fine at testnet scale, but a production version should use an indexer
  (e.g. The Graph) as report volume grows.
- The backend's `PRIVATE_KEY` is only used for read-side convenience scripts;
  all fund-moving transactions (stake, fund, approve, refund) are signed
  client-side via MetaMask, so the backend never custodies researcher or
  organization funds.
- **Juror randomness uses `blockhash`.** Fine for a testnet or demo, but a block producer could
  bias the draw. A production deployment should use a VRF such as Chainlink VRF.
- **No appeals.** A single 3-juror round decides a case; a tie or no-show quorum voids it and
  the party can re-open. Real systems add escalating appeal rounds.
- **Sybil resistance is economic only.** Jurors must stake and are slashed for non-coherence,
  but nothing stops one person running many juror wallets. The stake size is the defense.
- **Key derivation needs a deterministic signer.** Standard wallets (MetaMask, hardware wallets)
  sign deterministically, so the same key is recovered every time. Smart-contract wallets that
  sign non-deterministically are not supported.
- **Lost wallet means lost access.** The encryption key is derived from the wallet, so reports
  encrypted to a replaced key can't be re-read without the old one.
- A malicious site could ask a user to sign the key-derivation message and recover their key;
  only sign it on the PatchChain app you intended to use.
