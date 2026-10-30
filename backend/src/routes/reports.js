const express = require("express");
const { getContracts } = require("../utils/contracts");

const router = express.Router();

const STATUS = ["Submitted", "UnderReview", "Validated", "Rejected", "Disclosed"];

/**
 * GET /api/reports/:id
 * Report metadata from the registry. The content is end-to-end encrypted: the backend holds
 * no key and has no decrypt route. Encrypted reports are pinned and fetched through
 * /api/ipfs, and decrypted in the browser by someone whose key the report was wrapped for.
 */
router.get("/:id", async (req, res) => {
  try {
    const { registry, escrow } = getContracts();
    const report = await registry.getReport(req.params.id);

    res.json({
      reportId: Number(req.params.id),
      researcher: report.researcher,
      organization: report.organization,
      reportHash: report.reportHash,
      ipfsCID: report.ipfsCID,
      submittedAt: new Date(Number(report.submittedAt) * 1000).toISOString(),
      status: STATUS[report.status],
      severity: Number(report.severity),
      payoutState: Number(await escrow.payoutState(req.params.id)),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
