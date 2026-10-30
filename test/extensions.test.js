const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const E = ethers.parseEther;

const BASE_STAKE = E("0.01");
const JUROR_DEPOSIT = E("0.05");
const CASE_LOCK = E("0.02");
const FEE = E("0.01");
const EVIDENCE = 100;
const COMMIT = 100;
const REVEAL = 100;
const DISCLOSURE_WINDOW = 90 * 24 * 60 * 60;

const SAMPLE_HASH = ethers.keccak256(ethers.toUtf8Bytes("encrypted-envelope-bytes"));
const SAMPLE_CID = "bafybeigdyrztoken000samplecid0000000000000000000";
const PUBKEY = (label) => ethers.id(label); // any non-zero 32 bytes works for the registry

/**
 * Deploys the whole system with the court as the escrow's arbitrator and the
 * reputation contract wired into escrow + stake manager.
 */
async function deployAll({ jurorCount = 7 } = {}) {
  const signers = await ethers.getSigners();
  const [deployer, researcher, organization, outsider, ...rest] = signers;
  const jurors = rest.slice(0, jurorCount);
  const byAddress = new Map(signers.map((s) => [s.address, s]));

  const deploy = async (name, args = []) => {
    const f = await ethers.getContractFactory(name);
    const c = await f.deploy(...args);
    await c.waitForDeployment();
    return c;
  };

  const registry = await deploy("VulnerabilityRegistry");
  const stakeManager = await deploy("StakeManager", [await registry.getAddress(), BASE_STAKE]);
  const escrow = await deploy("BountyEscrow", [await registry.getAddress(), deployer.address]);
  const timer = await deploy("DisclosureTimer", [
    await registry.getAddress(),
    await escrow.getAddress(),
    DISCLOSURE_WINDOW,
  ]);
  const keyRegistry = await deploy("KeyRegistry");
  const reputation = await deploy("ReputationNFT");
  const court = await deploy("ArbitrationCourt", [
    await escrow.getAddress(),
    await keyRegistry.getAddress(),
    3, // panel size
    JUROR_DEPOSIT,
    CASE_LOCK,
    FEE,
    EVIDENCE,
    COMMIT,
    REVEAL,
  ]);

  await registry.setLinkedContracts(
    await stakeManager.getAddress(),
    await escrow.getAddress(),
    await timer.getAddress()
  );
  await escrow.setArbitrator(await court.getAddress());
  await escrow.setReputation(await reputation.getAddress());
  await stakeManager.setReputation(await reputation.getAddress());
  await reputation.setRecorder(await escrow.getAddress(), true);
  await reputation.setRecorder(await stakeManager.getAddress(), true);

  for (const j of jurors) {
    await keyRegistry.connect(j).registerKey(PUBKEY(`juror-${j.address}`));
    await court.connect(j).joinJury({ value: JUROR_DEPOSIT });
  }

  return {
    deployer,
    researcher,
    organization,
    outsider,
    jurors,
    byAddress,
    registry,
    stakeManager,
    escrow,
    timer,
    keyRegistry,
    reputation,
    court,
  };
}

/** Researcher submits a staked report; the org funds the escrow; the researcher disputes it. */
async function createDisputedReport(ctx) {
  const { researcher, organization, stakeManager, escrow, registry } = ctx;
  const stake = await stakeManager.requiredStakeFor(researcher.address);
  await stakeManager
    .connect(researcher)
    .submitReportWithStake(organization.address, SAMPLE_HASH, SAMPLE_CID, { value: stake });
  const reportId = Number(await registry.reportCount()) - 1;

  await escrow.connect(organization).fund({ value: E("5") });
  await escrow.connect(organization).setBountyTier(1, E("0.1"));
  await escrow.connect(organization).setBountyTier(3, E("1"));
  await escrow.connect(organization).setBountyTier(4, E("2"));
  // note: tier 2 is deliberately left unset (used by the execution-retry test)

  await escrow.connect(researcher).raiseDispute(reportId);
  return reportId;
}

/** Opens a case as the researcher, draws the panel, returns { caseId, panel }. */
async function openAndDraw(ctx, reportId) {
  const { court, researcher, byAddress } = ctx;
  await court.connect(researcher).openCase(reportId, { value: FEE });
  const caseId = Number(await court.caseCount()) - 1;
  await court.drawJurors(caseId);
  const addrs = await court.getJurors(caseId);
  return { caseId, panel: addrs.map((a) => byAddress.get(a)) };
}

/**
 * plan[i] = { ruling, commit?: false, reveal?: false } aligned to the panel order.
 * Advances time through evidence -> commit -> reveal.
 */
async function castVotes(ctx, caseId, panel, plan) {
  const { court } = ctx;
  const c = await court.getCase(caseId);
  const salts = panel.map((_, i) => ethers.id(`salt-${caseId}-${i}`));

  await time.increaseTo(Number(c.evidenceEnd) + 1);
  for (let i = 0; i < panel.length; i++) {
    if (plan[i].commit === false) continue;
    const commit = await court.hashVote(caseId, panel[i].address, plan[i].ruling, salts[i]);
    await court.connect(panel[i]).commitVote(caseId, commit);
  }

  await time.increaseTo(Number(c.commitEnd) + 1);
  for (let i = 0; i < panel.length; i++) {
    if (plan[i].commit === false || plan[i].reveal === false) continue;
    await court.connect(panel[i]).revealVote(caseId, plan[i].ruling, salts[i]);
  }
  return { salts, revealEnd: Number(c.revealEnd) };
}

const sum = async (court, jurors) => {
  let total = 0n;
  for (const j of jurors) total += await court.balanceOf(j.address);
  return total;
};

describe("PatchChain extensions", function () {
  describe("KeyRegistry", function () {
    it("stores and returns a public key", async function () {
      const ctx = await deployAll();
      const key = PUBKEY("org-key");
      await expect(ctx.keyRegistry.connect(ctx.organization).registerKey(key))
        .to.emit(ctx.keyRegistry, "KeyRegistered")
        .withArgs(ctx.organization.address, key);
      expect(await ctx.keyRegistry.publicKeyOf(ctx.organization.address)).to.equal(key);
      expect(await ctx.keyRegistry.hasKey(ctx.organization.address)).to.equal(true);
      expect(await ctx.keyRegistry.hasKey(ctx.outsider.address)).to.equal(false);
    });

    it("rejects an empty key and lets an owner replace their own key", async function () {
      const ctx = await deployAll();
      await expect(
        ctx.keyRegistry.connect(ctx.organization).registerKey(ethers.ZeroHash)
      ).to.be.revertedWith("KeyRegistry: empty key");

      await ctx.keyRegistry.connect(ctx.organization).registerKey(PUBKEY("a"));
      await ctx.keyRegistry.connect(ctx.organization).registerKey(PUBKEY("b"));
      expect(await ctx.keyRegistry.publicKeyOf(ctx.organization.address)).to.equal(PUBKEY("b"));
    });
  });

  describe("ReputationNFT", function () {
    let ctx;
    beforeEach(async function () {
      ctx = await deployAll();
    });

    it("lets a researcher claim exactly one soulbound badge", async function () {
      const { reputation, researcher, outsider } = ctx;
      await expect(reputation.connect(researcher).claim()).to.emit(reputation, "Locked").withArgs(1);

      expect(await reputation.ownerOf(1)).to.equal(researcher.address);
      expect(await reputation.balanceOf(researcher.address)).to.equal(1);
      expect(await reputation.locked(1)).to.equal(true);
      await expect(reputation.connect(researcher).claim()).to.be.revertedWith(
        "Reputation: already claimed"
      );

      // every transfer / approval path is blocked
      await expect(
        reputation.connect(researcher).transferFrom(researcher.address, outsider.address, 1)
      ).to.be.revertedWith("Reputation: soulbound");
      await expect(
        reputation.connect(researcher)["safeTransferFrom(address,address,uint256)"](
          researcher.address,
          outsider.address,
          1
        )
      ).to.be.revertedWith("Reputation: soulbound");
      await expect(reputation.connect(researcher).approve(outsider.address, 1)).to.be.revertedWith(
        "Reputation: soulbound"
      );
      await expect(
        reputation.connect(researcher).setApprovalForAll(outsider.address, true)
      ).to.be.revertedWith("Reputation: soulbound");
    });

    it("advertises ERC-721, metadata and ERC-5192 support", async function () {
      const { reputation } = ctx;
      expect(await reputation.supportsInterface("0x80ac58cd")).to.equal(true);
      expect(await reputation.supportsInterface("0x5b5e139f")).to.equal(true);
      expect(await reputation.supportsInterface("0xb45a3c0e")).to.equal(true);
      expect(await reputation.supportsInterface("0xffffffff")).to.equal(false);
    });

    it("only lets authorized recorders change scores", async function () {
      const { reputation, outsider, researcher } = ctx;
      await expect(
        reputation.connect(outsider).recordValidated(researcher.address, 4)
      ).to.be.revertedWith("Reputation: not a recorder");
      await expect(reputation.connect(outsider).recordRejected(researcher.address)).to.be.revertedWith(
        "Reputation: not a recorder"
      );
      await expect(
        reputation.connect(outsider).setRecorder(outsider.address, true)
      ).to.be.revertedWith("Reputation: not owner");
    });

    it("scores by severity, penalizes rejections, and floors at zero", async function () {
      const { reputation, deployer, researcher } = ctx;
      await reputation.setRecorder(deployer.address, true);

      await reputation.recordRejected(researcher.address); // already 0 -> stays 0
      expect(await reputation.scoreOf(researcher.address)).to.equal(0);

      await reputation.recordValidated(researcher.address, 2); // +25
      await reputation.recordRejected(researcher.address); // -15
      expect(await reputation.scoreOf(researcher.address)).to.equal(10);

      const p = await reputation.profileOf(researcher.address);
      expect(p.validated).to.equal(1);
      expect(p.rejected).to.equal(2);
      expect(p.medium).to.equal(1);
    });

    it("moves through ranks and shrinks the required stake", async function () {
      const { reputation, stakeManager, deployer, researcher } = ctx;
      await reputation.setRecorder(deployer.address, true);

      expect(await reputation.rankOf(researcher.address)).to.equal(0); // Rookie
      expect(await stakeManager.requiredStakeFor(researcher.address)).to.equal(BASE_STAKE);

      await reputation.recordValidated(researcher.address, 3); // 50 -> Hunter
      expect(await reputation.rankOf(researcher.address)).to.equal(1);
      expect(await stakeManager.requiredStakeFor(researcher.address)).to.equal((BASE_STAKE * 75n) / 100n);

      await reputation.recordValidated(researcher.address, 4); // 150 -> Elite
      expect(await reputation.rankOf(researcher.address)).to.equal(2);
      expect(await stakeManager.requiredStakeFor(researcher.address)).to.equal(BASE_STAKE / 2n);

      await reputation.recordValidated(researcher.address, 4);
      await reputation.recordValidated(researcher.address, 4);
      await reputation.recordValidated(researcher.address, 3); // 450 -> Legend
      expect(await reputation.rankOf(researcher.address)).to.equal(3);
      expect(await stakeManager.requiredStakeFor(researcher.address)).to.equal(BASE_STAKE / 4n);
    });

    it("credits reputation automatically when the organization pays a bounty", async function () {
      const { reputation, escrow, stakeManager, registry, researcher, organization } = ctx;
      await stakeManager
        .connect(researcher)
        .submitReportWithStake(organization.address, SAMPLE_HASH, SAMPLE_CID, { value: BASE_STAKE });
      await escrow.connect(organization).fund({ value: E("3") });
      await escrow.connect(organization).setBountyTier(3, E("1"));
      await escrow.connect(organization).approveAndPay(0, 3);

      expect(await reputation.scoreOf(researcher.address)).to.equal(50);
      expect(await reputation.rankOf(researcher.address)).to.equal(1);
      expect((await registry.getReport(0)).status).to.equal(2);
    });

    it("accepts the discounted stake for a Hunter and rejects the old full amount", async function () {
      const { reputation, stakeManager, deployer, researcher, organization } = ctx;
      await reputation.setRecorder(deployer.address, true);
      await reputation.recordValidated(researcher.address, 3); // Hunter, 75%

      await expect(
        stakeManager
          .connect(researcher)
          .submitReportWithStake(organization.address, SAMPLE_HASH, SAMPLE_CID, { value: BASE_STAKE })
      ).to.be.revertedWith("StakeManager: incorrect stake amount");

      await expect(
        stakeManager
          .connect(researcher)
          .submitReportWithStake(organization.address, SAMPLE_HASH, SAMPLE_CID, {
            value: (BASE_STAKE * 75n) / 100n,
          })
      ).to.emit(stakeManager, "StakeDeposited");
    });

    it("counts a forfeited (spam) stake against the researcher", async function () {
      const { reputation, stakeManager, deployer, researcher, organization } = ctx;
      await reputation.setRecorder(deployer.address, true);
      await reputation.recordValidated(researcher.address, 2); // 25

      await stakeManager
        .connect(researcher)
        .submitReportWithStake(organization.address, SAMPLE_HASH, SAMPLE_CID, { value: BASE_STAKE });
      await stakeManager.connect(organization).forfeitStake(0);

      expect(await reputation.scoreOf(researcher.address)).to.equal(10);
      expect((await reputation.profileOf(researcher.address)).rejected).to.equal(1);
    });

    it("generates fully on-chain metadata that tracks the live score", async function () {
      const { reputation, deployer, researcher } = ctx;
      await reputation.connect(researcher).claim();

      const decode = async () => {
        const uri = await reputation.tokenURI(1);
        expect(uri.startsWith("data:application/json;base64,")).to.equal(true);
        const json = JSON.parse(Buffer.from(uri.split(",")[1], "base64").toString());
        expect(json.image.startsWith("data:image/svg+xml;base64,")).to.equal(true);
        const svg = Buffer.from(json.image.split(",")[1], "base64").toString();
        return { json, svg };
      };
      const attr = (json, name) => json.attributes.find((a) => a.trait_type === name).value;

      let { json, svg } = await decode();
      expect(attr(json, "Rank")).to.equal("Rookie");
      expect(attr(json, "Score")).to.equal(0);
      expect(svg).to.include("Rookie");
      expect(svg).to.include(researcher.address.toLowerCase());
      expect(svg.startsWith("<svg")).to.equal(true);

      await reputation.setRecorder(deployer.address, true);
      await reputation.recordValidated(researcher.address, 4);
      await reputation.recordValidated(researcher.address, 4);

      ({ json, svg } = await decode());
      expect(attr(json, "Rank")).to.equal("Elite");
      expect(attr(json, "Score")).to.equal(200);
      expect(attr(json, "Validated")).to.equal(2);
      expect(svg).to.include("Elite");
      expect(svg).to.include("200 pts");
    });

    it("works with no reputation contract set (backwards compatible)", async function () {
      const { stakeManager, escrow, registry, researcher, organization } = ctx;
      await stakeManager.setReputation(ethers.ZeroAddress);
      await escrow.setReputation(ethers.ZeroAddress);

      expect(await stakeManager.requiredStakeFor(researcher.address)).to.equal(BASE_STAKE);
      await stakeManager
        .connect(researcher)
        .submitReportWithStake(organization.address, SAMPLE_HASH, SAMPLE_CID, { value: BASE_STAKE });
      await escrow.connect(organization).fund({ value: E("1") });
      await escrow.connect(organization).setBountyTier(1, E("0.1"));
      await escrow.connect(organization).approveAndPay(0, 1);
      expect((await registry.getReport(0)).status).to.equal(2);
    });
  });

  describe("DisclosureTimer — disclosure key", function () {
    let ctx;
    beforeEach(async function () {
      ctx = await deployAll();
      const { registry, timer, researcher, organization } = ctx;
      await registry.connect(researcher).submitReport(organization.address, SAMPLE_HASH, SAMPLE_CID);
      await timer.connect(researcher).startTimer(0);
    });

    it("cannot publish a key before the report is disclosed", async function () {
      await expect(
        ctx.timer.connect(ctx.researcher).publishDisclosureKey(0, PUBKEY("content-key"))
      ).to.be.revertedWith("Timer: report not disclosed");
    });

    it("lets only the researcher publish, once, after disclosure", async function () {
      const { timer, researcher, organization } = ctx;
      await time.increase(DISCLOSURE_WINDOW + 1);
      await timer.triggerAutoDisclosure(0);

      await expect(
        timer.connect(organization).publishDisclosureKey(0, PUBKEY("content-key"))
      ).to.be.revertedWith("Timer: not the researcher");
      await expect(
        timer.connect(researcher).publishDisclosureKey(0, ethers.ZeroHash)
      ).to.be.revertedWith("Timer: empty key");

      await expect(timer.connect(researcher).publishDisclosureKey(0, PUBKEY("content-key")))
        .to.emit(timer, "DisclosureKeyPublished")
        .withArgs(0, PUBKEY("content-key"));
      expect(await timer.disclosureKey(0)).to.equal(PUBKEY("content-key"));
      expect(await timer.keyPublished(0)).to.equal(true);

      await expect(
        timer.connect(researcher).publishDisclosureKey(0, PUBKEY("other"))
      ).to.be.revertedWith("Timer: key already published");
    });
  });

  describe("ArbitrationCourt — jury pool", function () {
    it("requires a registered encryption key and a sufficient deposit", async function () {
      const ctx = await deployAll();
      const { court, keyRegistry, outsider } = ctx;

      await expect(court.connect(outsider).joinJury({ value: JUROR_DEPOSIT })).to.be.revertedWith(
        "Court: register an encryption key first"
      );
      await keyRegistry.connect(outsider).registerKey(PUBKEY("outsider"));
      await expect(court.connect(outsider).joinJury({ value: JUROR_DEPOSIT - 1n })).to.be.revertedWith(
        "Court: deposit too small"
      );
      await court.connect(outsider).joinJury({ value: JUROR_DEPOSIT });
      expect(await court.isJuror(outsider.address)).to.equal(true);
      await expect(court.connect(outsider).joinJury({ value: JUROR_DEPOSIT })).to.be.revertedWith(
        "Court: already a juror"
      );
    });

    it("returns the whole balance when a juror leaves", async function () {
      const ctx = await deployAll();
      const { court, jurors } = ctx;
      const before = Number(await court.jurorCount());

      await expect(court.connect(jurors[0]).leaveJury()).to.changeEtherBalance(
        jurors[0],
        JUROR_DEPOSIT
      );
      expect(await court.isJuror(jurors[0].address)).to.equal(false);
      expect(Number(await court.jurorCount())).to.equal(before - 1);
      expect(await court.balanceOf(jurors[0].address)).to.equal(0);
    });
  });

  describe("ArbitrationCourt — opening and drawing", function () {
    let ctx, reportId;
    beforeEach(async function () {
      ctx = await deployAll();
      reportId = await createDisputedReport(ctx);
    });

    it("rejects cases that are not disputed, from non-parties, or with the wrong fee", async function () {
      const { court, escrow, registry, stakeManager, researcher, organization, outsider } = ctx;

      await expect(court.connect(outsider).openCase(reportId, { value: FEE })).to.be.revertedWith(
        "Court: not a party"
      );
      await expect(court.connect(researcher).openCase(reportId, { value: FEE - 1n })).to.be.revertedWith(
        "Court: incorrect fee"
      );

      // a second report that was never disputed
      await stakeManager
        .connect(researcher)
        .submitReportWithStake(organization.address, SAMPLE_HASH, SAMPLE_CID, {
          value: await stakeManager.requiredStakeFor(researcher.address),
        });
      const otherId = Number(await registry.reportCount()) - 1;
      expect(await escrow.payoutState(otherId)).to.equal(0);
      await expect(court.connect(researcher).openCase(otherId, { value: FEE })).to.be.revertedWith(
        "Court: report not disputed"
      );
    });

    it("needs a big enough jury pool", async function () {
      const small = await deployAll({ jurorCount: 4 }); // needs panel(3) + 2 = 5
      const id = await createDisputedReport(small);
      await expect(small.court.connect(small.researcher).openCase(id, { value: FEE })).to.be.revertedWith(
        "Court: not enough jurors"
      );
    });

    it("draws three distinct jurors, locks their stake, and never picks a party", async function () {
      const { court, keyRegistry, researcher, organization } = ctx;
      // make both parties jurors too, to prove they are excluded from their own case
      for (const party of [researcher, organization]) {
        await keyRegistry.connect(party).registerKey(PUBKEY(`party-${party.address}`));
        await court.connect(party).joinJury({ value: JUROR_DEPOSIT });
      }

      const { caseId, panel } = await openAndDraw(ctx, reportId);
      const addrs = panel.map((s) => s.address);

      expect(addrs.length).to.equal(3);
      expect(new Set(addrs).size).to.equal(3);
      expect(addrs).to.not.include(researcher.address);
      expect(addrs).to.not.include(organization.address);
      for (const a of addrs) {
        expect(await court.lockedOf(a)).to.equal(CASE_LOCK);
        expect(await court.isPanelist(caseId, a)).to.equal(true);
      }
      expect(await court.phaseOf(caseId)).to.equal(1); // Evidence

      await expect(court.drawJurors(caseId)).to.be.revertedWith("Court: already drawn");
    });

    it("blocks a second case while one is active, and stops jurors leaving mid-case", async function () {
      const { court, researcher, organization } = ctx;
      const { panel } = await openAndDraw(ctx, reportId);

      await expect(court.connect(organization).openCase(reportId, { value: FEE })).to.be.revertedWith(
        "Court: case already active"
      );
      await expect(court.connect(panel[0]).leaveJury()).to.be.revertedWith(
        "Court: stake locked in a case"
      );
      void researcher;
    });

    it("lets only the parties submit evidence, and only during the evidence period", async function () {
      const { court, researcher, organization, outsider } = ctx;
      const { caseId, panel } = await openAndDraw(ctx, reportId);

      await expect(court.connect(outsider).submitEvidence(caseId, "bafyevidence")).to.be.revertedWith(
        "Court: not a party"
      );
      await expect(court.connect(panel[0]).submitEvidence(caseId, "bafyevidence")).to.be.revertedWith(
        "Court: not a party"
      );
      await expect(court.connect(researcher).submitEvidence(caseId, "")).to.be.revertedWith(
        "Court: invalid CID"
      );

      await expect(court.connect(researcher).submitEvidence(caseId, "bafyresearcher"))
        .to.emit(court, "EvidenceSubmitted")
        .withArgs(caseId, researcher.address, "bafyresearcher");
      await court.connect(organization).submitEvidence(caseId, "bafyorg");

      const ev = await court.getEvidence(caseId);
      expect(ev.length).to.equal(2);
      expect(ev[0].cid).to.equal("bafyresearcher");
      expect(ev[1].party).to.equal(organization.address);

      await time.increase(EVIDENCE + 1);
      await expect(court.connect(researcher).submitEvidence(caseId, "late")).to.be.revertedWith(
        "Court: evidence period over"
      );
    });
  });

  describe("ArbitrationCourt — voting and settlement", function () {
    let ctx, reportId, caseId, panel;
    beforeEach(async function () {
      ctx = await deployAll();
      reportId = await createDisputedReport(ctx);
      ({ caseId, panel } = await openAndDraw(ctx, reportId));
    });

    it("enforces the commit / reveal timeline and vote integrity", async function () {
      const { court, outsider } = ctx;
      const salt = ethers.id("s");
      const commit = await court.hashVote(caseId, panel[0].address, 3, salt);

      await expect(court.connect(panel[0]).commitVote(caseId, commit)).to.be.revertedWith(
        "Court: evidence period still open"
      );

      await time.increase(EVIDENCE + 1);
      await expect(court.connect(outsider).commitVote(caseId, commit)).to.be.revertedWith(
        "Court: not on this panel"
      );
      await expect(court.connect(panel[0]).commitVote(caseId, ethers.ZeroHash)).to.be.revertedWith(
        "Court: empty commit"
      );
      await court.connect(panel[0]).commitVote(caseId, commit);

      await expect(court.connect(panel[0]).revealVote(caseId, 3, salt)).to.be.revertedWith(
        "Court: commit period still open"
      );

      await time.increase(COMMIT + 1);
      await expect(court.connect(panel[0]).commitVote(caseId, commit)).to.be.revertedWith(
        "Court: commit period over"
      );
      await expect(court.connect(panel[0]).revealVote(caseId, 4, salt)).to.be.revertedWith(
        "Court: reveal does not match commit"
      );
      await expect(court.connect(panel[0]).revealVote(caseId, 3, ethers.id("wrong"))).to.be.revertedWith(
        "Court: reveal does not match commit"
      );
      await expect(court.connect(panel[1]).revealVote(caseId, 3, salt)).to.be.revertedWith(
        "Court: no commit"
      );

      await court.connect(panel[0]).revealVote(caseId, 3, salt);
      await expect(court.connect(panel[0]).revealVote(caseId, 3, salt)).to.be.revertedWith(
        "Court: already revealed"
      );
    });

    it("pays the researcher at the median severity when the majority says pay", async function () {
      const { court, escrow, registry, reputation, jurors, researcher, outsider } = ctx;
      await castVotes(ctx, caseId, panel, [{ ruling: 3 }, { ruling: 4 }, { ruling: 3 }]);

      await expect(court.connect(outsider).finalize(caseId)).to.emit(court, "CaseExecuted");
      // (finalize ran after all reveals, no need to wait out the reveal period)

      const c = await court.getCase(caseId);
      expect(c.status).to.equal(2); // Decided
      expect(c.payResearcher).to.equal(true);
      expect(c.severity).to.equal(3); // lower median of [3,3,4]
      expect(c.executed).to.equal(true);

      expect(await escrow.payoutState(reportId)).to.equal(1); // Paid
      expect((await registry.getReport(reportId)).status).to.equal(2); // Validated
      expect(await reputation.scoreOf(researcher.address)).to.equal(50);

      // everyone was coherent: nobody is slashed, the fee is shared by the panel
      const panelAddrs = panel.map((s) => s.address);
      const total = await sum(court, panel);
      expect(total).to.equal(JUROR_DEPOSIT * 3n + FEE);
      for (const a of panelAddrs) expect(await court.lockedOf(a)).to.equal(0);
      void jurors;
    });

    it("pays out the actual bounty to the researcher", async function () {
      const { court, researcher, outsider } = ctx;
      await castVotes(ctx, caseId, panel, [{ ruling: 3 }, { ruling: 3 }, { ruling: 3 }]);

      await expect(court.connect(outsider).finalize(caseId)).to.changeEtherBalance(researcher, E("1"));
    });

    it("rejects the report on a majority reject and slashes the minority juror", async function () {
      const { court, escrow, registry, reputation, researcher, outsider } = ctx;
      await castVotes(ctx, caseId, panel, [{ ruling: 0 }, { ruling: 0 }, { ruling: 3 }]);
      await court.connect(outsider).finalize(caseId);

      const c = await court.getCase(caseId);
      expect(c.status).to.equal(2);
      expect(c.payResearcher).to.equal(false);
      expect(await escrow.payoutState(reportId)).to.equal(0); // NotPaid
      expect((await registry.getReport(reportId)).status).to.equal(3); // Rejected
      expect((await reputation.profileOf(researcher.address)).rejected).to.equal(1);

      // minority juror loses CASE_LOCK; the two coherent jurors split (CASE_LOCK + FEE)
      const reward = (CASE_LOCK + FEE) / 2n;
      expect(await court.balanceOf(panel[0].address)).to.equal(JUROR_DEPOSIT + reward);
      expect(await court.balanceOf(panel[1].address)).to.equal(JUROR_DEPOSIT + reward);
      expect(await court.balanceOf(panel[2].address)).to.equal(JUROR_DEPOSIT - CASE_LOCK);
      for (const s of panel) expect(await court.lockedOf(s.address)).to.equal(0);
    });

    it("slashes a juror who never reveals", async function () {
      const { court, outsider } = ctx;
      await castVotes(ctx, caseId, panel, [
        { ruling: 3 },
        { ruling: 3 },
        { ruling: 3, reveal: false }, // commits but goes silent
      ]);

      await expect(court.connect(outsider).finalize(caseId)).to.be.revertedWith(
        "Court: voting still open"
      );
      await time.increase(REVEAL + 1);
      await court.connect(outsider).finalize(caseId);

      expect(await court.balanceOf(panel[2].address)).to.equal(JUROR_DEPOSIT - CASE_LOCK);
      const reward = (CASE_LOCK + FEE) / 2n;
      expect(await court.balanceOf(panel[0].address)).to.equal(JUROR_DEPOSIT + reward);
    });

    it("voids a tied case, refunds the fee, and lets a party start over", async function () {
      const { court, researcher, outsider } = ctx;
      await castVotes(ctx, caseId, panel, [
        { ruling: 0 },
        { ruling: 3 },
        { ruling: 3, commit: false }, // no-show
      ]);
      await time.increase(REVEAL + 1);
      await court.connect(outsider).finalize(caseId);

      const c = await court.getCase(caseId);
      expect(c.status).to.equal(3); // Voided
      expect(await court.phaseOf(caseId)).to.equal(6);
      expect(await court.refundOf(researcher.address)).to.equal(FEE);

      // the no-show's slashed stake rewards the two jurors who did their duty
      expect(await court.balanceOf(panel[2].address)).to.equal(JUROR_DEPOSIT - CASE_LOCK);
      expect(await court.balanceOf(panel[0].address)).to.equal(JUROR_DEPOSIT + CASE_LOCK / 2n);

      await expect(court.connect(researcher).claimRefund()).to.changeEtherBalance(researcher, FEE);

      // the dispute is still open on the escrow, so a fresh case can be opened
      await court.connect(researcher).openCase(reportId, { value: FEE });
      expect(Number(await court.caseCount())).to.equal(2);
    });

    it("compensates the opener when nobody votes at all", async function () {
      const { court, researcher, outsider } = ctx;
      await castVotes(ctx, caseId, panel, [
        { ruling: 0, commit: false },
        { ruling: 0, commit: false },
        { ruling: 0, commit: false },
      ]);
      await time.increase(REVEAL + 1);
      await court.connect(outsider).finalize(caseId);

      expect((await court.getCase(caseId)).status).to.equal(3);
      // fee refund + the three slashed locks
      expect(await court.refundOf(researcher.address)).to.equal(FEE + CASE_LOCK * 3n);
      for (const s of panel) {
        expect(await court.balanceOf(s.address)).to.equal(JUROR_DEPOSIT - CASE_LOCK);
      }
    });

    it("keeps the ruling but lets execution be retried if the escrow call fails", async function () {
      const { court, escrow, organization, researcher, outsider } = ctx;
      // tier 2 is unset, so paying at severity 2 cannot execute yet
      await castVotes(ctx, caseId, panel, [{ ruling: 2 }, { ruling: 2 }, { ruling: 2 }]);
      await court.connect(outsider).finalize(caseId);

      let c = await court.getCase(caseId);
      expect(c.status).to.equal(2);
      expect(c.severity).to.equal(2);
      expect(c.executed).to.equal(false);
      expect(await escrow.payoutState(reportId)).to.equal(2); // still Disputed
      // jurors were still settled and rewarded
      expect(await sum(court, panel)).to.equal(JUROR_DEPOSIT * 3n + FEE);

      await expect(court.retryExecute(caseId)).to.be.revertedWith("Court: execution failed");

      await escrow.connect(organization).setBountyTier(2, E("0.5"));
      await expect(court.connect(outsider).retryExecute(caseId)).to.changeEtherBalance(
        researcher,
        E("0.5")
      );
      c = await court.getCase(caseId);
      expect(c.executed).to.equal(true);
      expect(await escrow.payoutState(reportId)).to.equal(1);

      await expect(court.retryExecute(caseId)).to.be.revertedWith("Court: nothing to execute");
    });

    it("lets jurors withdraw rewards but never funds that are locked", async function () {
      const { court, outsider } = ctx;
      await castVotes(ctx, caseId, panel, [{ ruling: 0 }, { ruling: 0 }, { ruling: 0 }]);
      await court.connect(outsider).finalize(caseId);

      const reward = FEE / 3n;
      const juror = panel[0];
      const balance = await court.balanceOf(juror.address);
      expect(balance).to.be.gte(JUROR_DEPOSIT + reward);

      await expect(court.connect(juror).withdraw(reward)).to.changeEtherBalance(juror, reward);
      await expect(court.connect(juror).withdraw(JUROR_DEPOSIT * 10n)).to.be.revertedWith(
        "Court: exceeds free balance"
      );
    });
  });
});
