/**
 * End-to-end encryption for PatchChain reports.
 *
 * Nothing here touches the network. Reports are encrypted in the researcher's browser,
 * so the backend and IPFS only ever see ciphertext and can never read one.
 *
 *   Keys        Each user has an X25519 keypair derived from a wallet signature (nothing to
 *               back up). The public half is published in the on-chain KeyRegistry.
 *   Content     A report is encrypted once with a random 32-byte content key
 *               (XSalsa20-Poly1305, NaCl secretbox).
 *   Access      The content key is "wrapped" (NaCl box, fresh ephemeral key per recipient)
 *               for the organization and the researcher. Giving jurors access later means
 *               adding more wraps; the ciphertext itself never changes.
 *   Disclosure  Publishing the content key on-chain makes a report public.
 *
 * Envelope: { v, alg, nonce, ct, wraps: { <lowercase address>: { epk, n, c } } }.
 * The envelope bytes are what gets pinned to IPFS, and their keccak256 goes on-chain.
 */
import nacl from "tweetnacl";
import { getBytes, hexlify, keccak256, toUtf8Bytes, toUtf8String } from "ethers";

export const ENVELOPE_VERSION = 1;
export const ALGORITHM = "x25519-xsalsa20-poly1305";

/**
 * Every user signs this same message; the signature (which only their wallet can produce)
 * is hashed into their private key. Signing it costs no gas and authorizes nothing.
 */
export const KEY_DERIVATION_MESSAGE =
  "PatchChain encryption key (v1)\n\n" +
  "Sign this message to unlock your PatchChain encryption key. " +
  "It costs no gas and does not authorize any transaction.\n\n" +
  "Only sign this on the PatchChain app you intended to use.";

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

export function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toBytes(value) {
  return typeof value === "string" ? getBytes(value) : value;
}

function publicKeyBytes(publicKey) {
  const bytes = toBytes(publicKey);
  if (bytes.length !== nacl.box.publicKeyLength) {
    throw new Error("Invalid public key length (expected 32 bytes)");
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/**
 * Derives the user's keypair from their wallet's signature of KEY_DERIVATION_MESSAGE.
 * Standard wallets sign deterministically (RFC 6979), so the same wallet always gets the
 * same key. Smart-contract wallets that sign non-deterministically are not supported.
 */
export function deriveKeyPair(signature) {
  const seed = getBytes(keccak256(signature));
  const pair = nacl.box.keyPair.fromSecretKey(seed);
  return {
    publicKey: pair.publicKey,
    secretKey: pair.secretKey,
    publicKeyHex: hexlify(pair.publicKey), // 0x + 64 hex = bytes32 for KeyRegistry
  };
}

// ---------------------------------------------------------------------------
// Wrapping the content key
// ---------------------------------------------------------------------------

function wrapKey(contentKey, recipientPublicKey) {
  const ephemeral = nacl.box.keyPair();
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const boxed = nacl.box(contentKey, nonce, publicKeyBytes(recipientPublicKey), ephemeral.secretKey);
  return {
    epk: bytesToBase64(ephemeral.publicKey),
    n: bytesToBase64(nonce),
    c: bytesToBase64(boxed),
  };
}

function unwrapKey(wrap, secretKey) {
  if (!wrap || !wrap.epk || !wrap.n || !wrap.c) throw new Error("Malformed key wrap");
  const key = nacl.box.open(
    base64ToBytes(wrap.c),
    base64ToBytes(wrap.n),
    base64ToBytes(wrap.epk),
    secretKey
  );
  if (!key) throw new Error("Could not unlock the report key with your encryption key");
  return key;
}

function wrapsFor(contentKey, recipients) {
  const wraps = {};
  for (const [address, publicKey] of Object.entries(recipients)) {
    wraps[address.toLowerCase()] = wrapKey(contentKey, publicKey);
  }
  if (Object.keys(wraps).length === 0) throw new Error("At least one recipient is required");
  return wraps;
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

function serialize(envelope) {
  const envelopeBytes = toUtf8Bytes(JSON.stringify(envelope));
  return { envelopeBytes, reportHash: keccak256(envelopeBytes) };
}

/** Parses an envelope (bytes, string or an already-parsed object) and checks its shape. */
export function parseEnvelope(input) {
  let env;
  if (input && !(input instanceof Uint8Array) && typeof input === "object") {
    env = input; // already parsed
  } else {
    try {
      env = JSON.parse(typeof input === "string" ? input : toUtf8String(input));
    } catch {
      throw new Error("Not a PatchChain envelope");
    }
  }
  if (
    !env ||
    env.v !== ENVELOPE_VERSION ||
    env.alg !== ALGORITHM ||
    typeof env.nonce !== "string" ||
    typeof env.ct !== "string" ||
    !env.wraps ||
    typeof env.wraps !== "object"
  ) {
    throw new Error("Not a PatchChain envelope");
  }
  return env;
}

/**
 * Encrypts a report object for a set of recipients.
 * @param {object} report
 * @param {Object<string,string|Uint8Array>} recipients  address -> encryption public key
 * @returns {{ envelopeBytes: Uint8Array, reportHash: string, contentKeyHex: string }}
 *   envelopeBytes is pinned to IPFS and reportHash = keccak256(envelopeBytes) goes on-chain.
 *   contentKeyHex is the symmetric key; keep it only if the report may be disclosed later.
 */
export function encryptReport(report, recipients) {
  const contentKey = nacl.randomBytes(nacl.secretbox.keyLength);
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const ct = nacl.secretbox(toUtf8Bytes(JSON.stringify(report)), nonce, contentKey);

  const envelope = {
    v: ENVELOPE_VERSION,
    alg: ALGORITHM,
    nonce: bytesToBase64(nonce),
    ct: bytesToBase64(ct),
    wraps: wrapsFor(contentKey, recipients),
  };
  return { ...serialize(envelope), contentKeyHex: hexlify(contentKey) };
}

/** Recovers the 32-byte content key for `address` (returns a Uint8Array). */
export function unlockContentKey(envelopeInput, address, secretKey) {
  const env = parseEnvelope(envelopeInput);
  const wrap = env.wraps[address.toLowerCase()];
  if (!wrap) throw new Error("This report was not encrypted for your address");
  return unwrapKey(wrap, secretKey);
}

/** Decrypts an envelope once the content key is known (hex string or bytes). */
export function decryptWithContentKey(envelopeInput, contentKey) {
  const env = parseEnvelope(envelopeInput);
  const key = toBytes(contentKey);
  if (key.length !== nacl.secretbox.keyLength) throw new Error("Invalid content key length");
  const plaintext = nacl.secretbox.open(base64ToBytes(env.ct), base64ToBytes(env.nonce), key);
  if (!plaintext) {
    throw new Error("Report failed authentication — it was modified, or the key is wrong");
  }
  return JSON.parse(toUtf8String(plaintext));
}

/** Decrypts a report for a recipient listed in the envelope. Returns the report object. */
export function decryptReport(envelopeInput, address, secretKey) {
  return decryptWithContentKey(envelopeInput, unlockContentKey(envelopeInput, address, secretKey));
}

/**
 * Adds recipients (e.g. the jurors drawn for a dispute) to an existing envelope. The caller
 * must already be able to open it. The ciphertext is untouched; only new key wraps are added.
 * @returns {{ envelopeBytes: Uint8Array, reportHash: string }}
 */
export function addRecipients(envelopeInput, address, secretKey, newRecipients) {
  const env = parseEnvelope(envelopeInput);
  const contentKey = unlockContentKey(env, address, secretKey);
  const extra = wrapsFor(contentKey, newRecipients);
  return serialize({ ...env, wraps: { ...env.wraps, ...extra } });
}
