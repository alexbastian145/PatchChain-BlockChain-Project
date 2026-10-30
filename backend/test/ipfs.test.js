// Run with: npm test   (node's built-in test runner)
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

const ipfsRouter = require("../src/routes/ipfs");
const { looksLikeEnvelope } = ipfsRouter;

const envelope = {
  v: 1,
  alg: "x25519-xsalsa20-poly1305",
  nonce: "bm9uY2U=",
  ct: "Y2lwaGVydGV4dA==",
  wraps: { "0xabc": { epk: "a", n: "b", c: "c" } },
};
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64");

async function withServer(fn) {
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  app.use("/api/ipfs", ipfsRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

const post = (base, body) =>
  fetch(`${base}/api/ipfs/pin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

test("accepts a well-formed ciphertext envelope", () => {
  assert.equal(looksLikeEnvelope(Buffer.from(JSON.stringify(envelope))), true);
});

test("rejects plaintext reports, even ones that mimic the envelope fields", () => {
  const plain = { title: "XSS", description: "details", stepsToReproduce: "..." };
  assert.equal(looksLikeEnvelope(Buffer.from(JSON.stringify(plain))), false);
  assert.equal(looksLikeEnvelope(Buffer.from(JSON.stringify({ ...envelope, title: "leak" }))), false);
  assert.equal(looksLikeEnvelope(Buffer.from(JSON.stringify({ ...envelope, description: "leak" }))), false);
});

test("rejects malformed or incomplete envelopes", () => {
  assert.equal(looksLikeEnvelope(Buffer.from("not json at all")), false);
  assert.equal(looksLikeEnvelope(Buffer.from(JSON.stringify({ ...envelope, v: 2 }))), false);
  assert.equal(looksLikeEnvelope(Buffer.from(JSON.stringify({ ...envelope, wraps: {} }))), false);
  assert.equal(looksLikeEnvelope(Buffer.from(JSON.stringify({ ...envelope, ct: undefined }))), false);
});

test("POST /pin returns 400 without data and for plaintext, before touching IPFS", async () => {
  await withServer(async (base) => {
    let res = await post(base, {});
    assert.equal(res.status, 400);

    res = await post(base, { data: b64({ title: "plaintext", description: "oops" }) });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /encrypted PatchChain envelopes/);
  });
});

test("GET /:cid rejects malformed CIDs", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/ipfs/..%2Fetc`);
    assert.equal(res.status, 400);
  });
});
