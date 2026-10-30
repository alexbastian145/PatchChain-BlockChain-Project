// Run with: npm test   (node's built-in test runner — no extra dependencies)
import test from "node:test";
import assert from "node:assert/strict";
import { Wallet, keccak256, toUtf8Bytes } from "ethers";
import {
  KEY_DERIVATION_MESSAGE,
  addRecipients,
  decryptReport,
  decryptWithContentKey,
  deriveKeyPair,
  encryptReport,
  parseEnvelope,
  unlockContentKey,
} from "./e2ee.js";

const sign = (wallet) => wallet.signMessage(KEY_DERIVATION_MESSAGE);
const REPORT = {
  title: "Stored XSS in profile bio",
  description: "The bio field is rendered unescaped.",
  stepsToReproduce: "1. Set bio to <script>alert(1)</script>",
};

async function actor() {
  const wallet = Wallet.createRandom();
  const keys = deriveKeyPair(await sign(wallet));
  return { wallet, address: wallet.address, ...keys };
}

test("key derivation is deterministic per wallet and differs between wallets", async () => {
  const w = Wallet.createRandom();
  const a = deriveKeyPair(await sign(w));
  const b = deriveKeyPair(await sign(w));
  const other = deriveKeyPair(await sign(Wallet.createRandom()));

  assert.equal(a.publicKeyHex, b.publicKeyHex);
  assert.deepEqual(a.secretKey, b.secretKey);
  assert.notEqual(a.publicKeyHex, other.publicKeyHex);
  assert.equal(a.publicKey.length, 32);
});

test("the organization and the researcher can both decrypt; the plaintext never appears in the envelope", async () => {
  const org = await actor();
  const researcher = await actor();
  const { envelopeBytes, reportHash } = encryptReport(REPORT, {
    [org.address]: org.publicKeyHex,
    [researcher.address]: researcher.publicKeyHex,
  });

  assert.equal(reportHash, keccak256(envelopeBytes));
  const text = Buffer.from(envelopeBytes).toString();
  assert.ok(!text.includes("Stored XSS"));
  assert.ok(!text.includes("unescaped"));

  assert.deepEqual(decryptReport(envelopeBytes, org.address, org.secretKey), REPORT);
  assert.deepEqual(decryptReport(envelopeBytes, researcher.address, researcher.secretKey), REPORT);
});

test("address lookup is case-insensitive", async () => {
  const org = await actor();
  const { envelopeBytes } = encryptReport(REPORT, { [org.address]: org.publicKeyHex });
  assert.deepEqual(decryptReport(envelopeBytes, org.address.toLowerCase(), org.secretKey), REPORT);
});

test("an outsider or the wrong key cannot decrypt", async () => {
  const org = await actor();
  const outsider = await actor();
  const { envelopeBytes } = encryptReport(REPORT, { [org.address]: org.publicKeyHex });

  assert.throws(() => decryptReport(envelopeBytes, outsider.address, outsider.secretKey), /not encrypted for your address/);
  // right address, wrong secret key
  assert.throws(() => decryptReport(envelopeBytes, org.address, outsider.secretKey), /Could not unlock/);
});

test("tampering with the ciphertext is detected", async () => {
  const org = await actor();
  const { envelopeBytes } = encryptReport(REPORT, { [org.address]: org.publicKeyHex });

  const env = JSON.parse(Buffer.from(envelopeBytes).toString());
  const ct = Buffer.from(env.ct, "base64");
  ct[0] ^= 0xff;
  env.ct = ct.toString("base64");
  const tampered = toUtf8Bytes(JSON.stringify(env));

  assert.notEqual(keccak256(tampered), keccak256(envelopeBytes));
  assert.throws(() => decryptReport(tampered, org.address, org.secretKey), /failed authentication/);
});

test("two encryptions of the same report differ (fresh key and nonce each time)", async () => {
  const org = await actor();
  const a = encryptReport(REPORT, { [org.address]: org.publicKeyHex });
  const b = encryptReport(REPORT, { [org.address]: org.publicKeyHex });
  assert.notEqual(a.reportHash, b.reportHash);
  assert.notEqual(a.contentKeyHex, b.contentKeyHex);
});

test("a party can add jurors as recipients without changing the ciphertext", async () => {
  const org = await actor();
  const researcher = await actor();
  const juror1 = await actor();
  const juror2 = await actor();
  const original = encryptReport(REPORT, {
    [org.address]: org.publicKeyHex,
    [researcher.address]: researcher.publicKeyHex,
  });

  const evidence = addRecipients(original.envelopeBytes, researcher.address, researcher.secretKey, {
    [juror1.address]: juror1.publicKeyHex,
    [juror2.address]: juror2.publicKeyHex,
  });

  assert.deepEqual(decryptReport(evidence.envelopeBytes, juror1.address, juror1.secretKey), REPORT);
  assert.deepEqual(decryptReport(evidence.envelopeBytes, juror2.address, juror2.secretKey), REPORT);
  // original recipients still work, ciphertext is untouched
  assert.deepEqual(decryptReport(evidence.envelopeBytes, org.address, org.secretKey), REPORT);
  assert.equal(parseEnvelope(evidence.envelopeBytes).ct, parseEnvelope(original.envelopeBytes).ct);
  // the original envelope never granted jurors access
  assert.throws(() => decryptReport(original.envelopeBytes, juror1.address, juror1.secretKey));
  // someone who cannot open the report cannot add recipients
  const outsider = await actor();
  assert.throws(() =>
    addRecipients(original.envelopeBytes, outsider.address, outsider.secretKey, {
      [juror1.address]: juror1.publicKeyHex,
    })
  );
});

test("a published content key lets anyone decrypt, and a wrong key does not", async () => {
  const org = await actor();
  const { envelopeBytes, contentKeyHex } = encryptReport(REPORT, { [org.address]: org.publicKeyHex });

  assert.deepEqual(decryptWithContentKey(envelopeBytes, contentKeyHex), REPORT);
  // the key the researcher would publish is exactly what unwrapping yields
  const unwrapped = unlockContentKey(envelopeBytes, org.address, org.secretKey);
  assert.equal("0x" + Buffer.from(unwrapped).toString("hex"), contentKeyHex);

  const wrong = "0x" + "11".repeat(32);
  assert.throws(() => decryptWithContentKey(envelopeBytes, wrong), /failed authentication/);
});

test("non-envelopes and bad inputs are rejected", async () => {
  assert.throws(() => parseEnvelope(toUtf8Bytes("just some plaintext")), /Not a PatchChain envelope/);
  assert.throws(() => parseEnvelope(toUtf8Bytes(JSON.stringify({ title: "plaintext report" }))), /Not a PatchChain envelope/);
  assert.throws(() => encryptReport(REPORT, {}), /At least one recipient/);

  const org = await actor();
  assert.throws(() => encryptReport(REPORT, { [org.address]: "0x1234" }), /Invalid public key length/);
});
