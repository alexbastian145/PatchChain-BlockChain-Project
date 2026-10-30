// End-to-end: the REAL frontend encryption module driving the REAL contracts.
// Everything the UI does across KeyRegistry, StakeManager, BountyEscrow, ArbitrationCourt,
// ReputationNFT and DisclosureTimer is exercised here, with IPFS replaced by an in-memory map.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const E = ethers.parseEther;
const REPORT = {
  title: "Authentication bypass via JWT alg=none",
  description: "The API accepts unsigned tokens.",
  stepsToReproduce: "1. Forge a token with alg none\n2. Call /admin",
};

describe("PatchChain — encrypted end-to-end flow", function () {
  this.timeout(120000);

  let e2ee, KEY_MSG;
  let ctx;
  const ipfs = new Map(); // cid -> Uint8Array
  let cidCounter = 0;
  const pin = (bytes) => {
    const cid = `bafyfake${String(++cidCounter).padStart(8, "0")}contentidentifier`;
    ipfs.set(cid, bytes);
    return cid;
  };

  const keysFor = async (signer) => e2ee.deriveKeyPair(await signer.signMessage(KEY_MSG));

  before(async function () {
    e2ee = await import("../frontend/src/utils/e2ee.js");
    KEY_MSG = e2ee.KEY_DERIVATION_MESSAGE;
  });

  beforeEach(async function () {
    ipfs.clear();
    const [deployer, researcher, organization, ...rest] = await ethers.getSigners();
    const jurors = rest.slice(0, 6);

    const { main } = require("../scripts/deploy.js");
    // Deploy via the real script, with short court periods so the test can step through them.
    process.env.COURT_EVIDENCE_SECONDS = "100";
    process.env.COURT_COMMIT_SECONDS = "100";
    process.env.COURT_REVEAL_SECONDS = "100";
    const addr = await main();

    const at = (name, a) => ethers.getContractAt(name, a);
    ctx = {
      deployer,
      researcher,
      organization,
      jurors,
      registry: await at("VulnerabilityRegistry", addr.VulnerabilityRegistry),
      stakeManager: await at("StakeManager", addr.StakeManager),
      escrow: await at("BountyEscrow", addr.BountyEscrow),
      timer: await at("DisclosureTimer", addr.DisclosureTimer),
      keyRegistry: await at("KeyRegistry", addr.KeyRegistry),
      reputation: await at("ReputationNFT", addr.ReputationNFT),
      court: await at("ArbitrationCourt", addr.ArbitrationCourt),
    };
  });

  async function submitEncrypted() {
    const { researcher, organization, keyRegistry, stakeManager, registry } = ctx;

    // Organization publishes its encryption key (what EncryptionKeyCard does).
    const orgKeys = await keysFor(organization);
    await keyRegistry.connect(organization).registerKey(orgKeys.publicKeyHex);

    // Researcher encrypts in the browser for the org + themselves (what SubmitReport does).
    const resKeys = await keysFor(researcher);
    const orgKeyOnChain = await keyRegistry.publicKeyOf(organization.address);
    const { envelopeBytes, reportHash, contentKeyHex } = e2ee.encryptReport(REPORT, {
      [organization.address]: orgKeyOnChain,
      [researcher.address]: resKeys.publicKeyHex,
    });
    const cid = pin(envelopeBytes);

    const stake = await stakeManager.requiredStakeFor(researcher.address);
    await stakeManager.connect(researcher).submitReportWithStake(organization.address, reportHash, cid, { value: stake });
    const reportId = Number(await registry.reportCount()) - 1;
    return { orgKeys, resKeys, reportId, cid, reportHash, contentKeyHex };
  }

  it("the organization can decrypt, the chain only holds a hash, and tampering is caught", async function () {
    const { organization, registry, researcher } = ctx;
    const { orgKeys, reportId, cid, reportHash } = await submitEncrypted();

    const onChain = await registry.getReport(reportId);
    expect(onChain.reportHash).to.equal(reportHash);
    expect(onChain.ipfsCID).to.equal(cid);

    // What IPFS (and therefore the backend) holds is unreadable ciphertext.
    const stored = ipfs.get(cid);
    expect(Buffer.from(stored).toString()).to.not.include("JWT");
    expect(ethers.keccak256(stored)).to.equal(onChain.reportHash);

    // The organization decrypts it.
    expect(e2ee.decryptReport(stored, organization.address, orgKeys.secretKey)).to.deep.equal(REPORT);

    // An outsider who fetched the same ciphertext cannot.
    const outsider = ctx.jurors[0];
    const outsiderKeys = await keysFor(outsider);
    expect(() => e2ee.decryptReport(stored, outsider.address, outsiderKeys.secretKey)).to.throw();
    void researcher;

    // Swapping the stored bytes breaks the on-chain hash check the UI performs.
    const tampered = Uint8Array.from(stored);
    tampered[tampered.length - 5] ^= 1;
    expect(ethers.keccak256(tampered)).to.not.equal(onChain.reportHash);
  });

  it("full dispute: jurors get the report re-wrapped, vote in secret, and the bounty is paid", async function () {
    const { researcher, organization, jurors, keyRegistry, escrow, court, registry, reputation } = ctx;
    const { resKeys, reportId, cid, reportHash } = await submitEncrypted();

    // Jury pool forms; every juror publishes a key first (court enforces it).
    const jurorKeys = new Map();
    for (const j of jurors) {
      const k = await keysFor(j);
      jurorKeys.set(j.address, k);
      await keyRegistry.connect(j).registerKey(k.publicKeyHex);
      await court.connect(j).joinJury({ value: E("0.05") });
    }

    // Organization sets up bounty tiers; researcher disputes; researcher opens the case.
    await escrow.connect(organization).fund({ value: E("3") });
    await escrow.connect(organization).setBountyTier(3, E("1"));
    await escrow.connect(researcher).raiseDispute(reportId);
    await court.connect(researcher).openCase(reportId, { value: E("0.01") });
    await court.drawJurors(0);
    const panelAddrs = await court.getJurors(0);
    const panel = panelAddrs.map((a) => jurors.find((j) => j.address === a));

    // Researcher re-wraps the report for exactly the drawn panel (what "Share with the jury" does).
    const original = ipfs.get(cid);
    expect(ethers.keccak256(original)).to.equal(reportHash);
    const recipients = {};
    for (const j of panel) recipients[j.address] = await keyRegistry.publicKeyOf(j.address);
    const shared = e2ee.addRecipients(original, researcher.address, resKeys.secretKey, recipients);
    const evidenceCid = pin(shared.envelopeBytes);
    await court.connect(researcher).submitEvidence(0, evidenceCid);

    // Every juror reads the evidence; the jurors NOT drawn cannot.
    const evidence = (await court.getEvidence(0))[0];
    for (const j of panel) {
      const content = e2ee.decryptReport(ipfs.get(evidence.cid), j.address, jurorKeys.get(j.address).secretKey);
      expect(content).to.deep.equal(REPORT);
    }
    const bystander = jurors.find((j) => !panelAddrs.includes(j.address));
    expect(() =>
      e2ee.decryptReport(ipfs.get(evidence.cid), bystander.address, jurorKeys.get(bystander.address).secretKey)
    ).to.throw();

    // Sealed votes: two say pay at High, one rejects.
    const rulings = [3, 3, 0];
    const salts = panel.map((_, i) => ethers.id(`salt-${i}`));
    const c0 = await court.getCase(0);
    await time.increaseTo(Number(c0.evidenceEnd) + 1);
    for (let i = 0; i < 3; i++) {
      await court.connect(panel[i]).commitVote(0, await court.hashVote(0, panel[i].address, rulings[i], salts[i]));
    }
    await time.increaseTo(Number(c0.commitEnd) + 1);
    for (let i = 0; i < 3; i++) await court.connect(panel[i]).revealVote(0, rulings[i], salts[i]);

    // Finalize pays the researcher the High bounty and credits reputation.
    await expect(court.finalize(0)).to.changeEtherBalance(researcher, E("1"));
    expect((await registry.getReport(reportId)).status).to.equal(2); // Validated
    expect(await reputation.scoreOf(researcher.address)).to.equal(50);
    expect(await reputation.rankOf(researcher.address)).to.equal(1); // Hunter

    // The dissenting juror was slashed, the majority rewarded.
    expect(await court.balanceOf(panel[2].address)).to.equal(E("0.05") - E("0.02"));
    expect(await court.balanceOf(panel[0].address)).to.be.gt(E("0.05"));

    // Next report: the researcher's stake is now discounted by 25%.
    expect(await ctx.stakeManager.requiredStakeFor(researcher.address)).to.equal(E("0.0075"));
  });

  it("disclosure: after the deadline the researcher publishes the key and anyone can read the report", async function () {
    const { researcher, timer } = ctx;
    const { resKeys, reportId, cid, reportHash } = await submitEncrypted();

    await timer.connect(researcher).startTimer(reportId);
    await time.increase(90 * 24 * 60 * 60 + 1);
    await timer.triggerAutoDisclosure(reportId);

    // Researcher recovers the content key from their own wrap and publishes it (what MyReports does).
    const envelope = ipfs.get(cid);
    const contentKey = ethers.hexlify(e2ee.unlockContentKey(envelope, researcher.address, resKeys.secretKey));
    await timer.connect(researcher).publishDisclosureKey(reportId, contentKey);

    // A stranger with no wrapped key reads it using only on-chain data + IPFS.
    const publicKey = await timer.disclosureKey(reportId);
    expect(ethers.keccak256(ipfs.get(cid))).to.equal(reportHash);
    expect(e2ee.decryptWithContentKey(ipfs.get(cid), publicKey)).to.deep.equal(REPORT);
  });
});
