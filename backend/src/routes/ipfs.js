const express = require("express");
const { ethers } = require("ethers");
const { uploadToIPFS, fetchFromIPFS } = require("../utils/ipfs");

const router = express.Router();

/**
 * The backend is a dumb pinning relay. Reports are encrypted in the browser
 * (see frontend/src/utils/e2ee.js) so this service never holds a key and never
 * sees plaintext. To keep it from being used as a free plaintext host, uploads
 * must be PatchChain ciphertext envelopes: valid structure, no readable fields.
 */
function looksLikeEnvelope(buffer) {
  try {
    const env = JSON.parse(buffer.toString("utf8"));
    return (
      env &&
      env.v === 1 &&
      env.alg === "x25519-xsalsa20-poly1305" &&
      typeof env.nonce === "string" &&
      typeof env.ct === "string" &&
      env.wraps &&
      typeof env.wraps === "object" &&
      Object.keys(env.wraps).length > 0 &&
      // a plaintext report would carry readable fields at the top level
      !("title" in env) &&
      !("description" in env)
    );
  } catch {
    return false;
  }
}

/**
 * POST /api/ipfs/pin
 * body: { data: "<base64 envelope bytes>" }
 * Returns the CID and the keccak256 of the exact bytes pinned, which the client
 * checks against its own hash before sending the on-chain transaction.
 */
router.post("/pin", async (req, res) => {
  try {
    const { data } = req.body || {};
    if (typeof data !== "string" || data.length === 0) {
      return res.status(400).json({ error: "'data' (base64 envelope) is required" });
    }

    const buffer = Buffer.from(data, "base64");
    if (!looksLikeEnvelope(buffer)) {
      return res.status(400).json({ error: "Only encrypted PatchChain envelopes can be pinned" });
    }

    const cid = await uploadToIPFS(buffer, `report-${Date.now()}.enc`);
    res.json({ cid, reportHash: ethers.keccak256(buffer) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/ipfs/:cid
 * Returns the stored ciphertext as base64. Anyone may fetch it — that is safe,
 * only holders of a wrapped key can read it. The client verifies the keccak256
 * against the hash recorded on-chain.
 */
router.get("/:cid", async (req, res) => {
  try {
    const { cid } = req.params;
    if (!/^[A-Za-z0-9]{10,128}$/.test(cid)) {
      return res.status(400).json({ error: "Invalid CID" });
    }
    const buffer = await fetchFromIPFS(cid);
    res.json({ cid, reportHash: ethers.keccak256(buffer), data: buffer.toString("base64") });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.looksLikeEnvelope = looksLikeEnvelope;
