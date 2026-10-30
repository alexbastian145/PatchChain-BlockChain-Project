const express = require("express");
const { ethers } = require("ethers");
const { getContracts } = require("../utils/contracts");

const STATUS = ["Submitted", "UnderReview", "Validated", "Rejected", "Disclosed"];

const router = express.Router();

/**
 * GET /api/organizations/:address/reports
 * Scans ReportSubmitted events to list all reports addressed to an organization.
 * For a production system this would be backed by an indexer (e.g. The Graph);
 * event log scanning is fine at hackathon/testnet scale.
 */
router.get("/organizations/:address/reports", async (req, res) => {
  try {
    const { registry, escrow } = getContracts();
    const address = req.params.address;
    if (!ethers.isAddress(address)) {
      return res.status(400).json({ error: "Invalid organization address" });
    }

    const filter = registry.filters.ReportSubmitted(null, null, address);
    const events = await registry.queryFilter(filter, 0, "latest");

    const reports = await Promise.all(
      events.map(async (ev) => {
        const r = await registry.getReport(ev.args.reportId);
        return {
          reportId: Number(ev.args.reportId),
          researcher: r.researcher,
          reportHash: r.reportHash,
          ipfsCID: r.ipfsCID,
          submittedAt: new Date(Number(r.submittedAt) * 1000).toISOString(),
          status: STATUS[r.status],
          payoutState: Number(await escrow.payoutState(ev.args.reportId)),
          severity: Number(r.severity),
        };
      })
    );

    res.json({ organization: address, reports });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/researchers/:address/reports
 * Same idea, filtered by researcher.
 */
router.get("/researchers/:address/reports", async (req, res) => {
  try {
    const { registry, escrow } = getContracts();
    const address = req.params.address;
    if (!ethers.isAddress(address)) {
      return res.status(400).json({ error: "Invalid researcher address" });
    }

    const filter = registry.filters.ReportSubmitted(null, address, null);
    const events = await registry.queryFilter(filter, 0, "latest");

    const reports = await Promise.all(
      events.map(async (ev) => {
        const r = await registry.getReport(ev.args.reportId);
        return {
          reportId: Number(ev.args.reportId),
          organization: r.organization,
          reportHash: r.reportHash,
          ipfsCID: r.ipfsCID,
          submittedAt: new Date(Number(r.submittedAt) * 1000).toISOString(),
          status: STATUS[r.status],
          payoutState: Number(await escrow.payoutState(ev.args.reportId)),
          severity: Number(r.severity),
        };
      })
    );

    res.json({ researcher: address, reports });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/reports/:id/timer
 * Returns the disclosure countdown status for a report.
 */
router.get("/reports/:id/timer", async (req, res) => {
  try {
    const { timer } = getContracts();
    const remaining = await timer.timeRemaining(req.params.id);
    const disclosed = await timer.disclosed(req.params.id);
    res.json({
      reportId: Number(req.params.id),
      secondsRemaining: Number(remaining),
      disclosed,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
