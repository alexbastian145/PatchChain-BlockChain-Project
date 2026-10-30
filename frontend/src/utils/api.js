import { keccak256 } from "ethers";
import { BACKEND_URL } from "../config";
import { base64ToBytes, bytesToBase64 } from "./e2ee";

/** Pin an encrypted envelope to IPFS through the backend relay. Returns { cid, reportHash }. */
export async function pinEnvelope(envelopeBytes) {
  const res = await fetch(`${BACKEND_URL}/api/ipfs/pin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: bytesToBase64(envelopeBytes) }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || "Failed to pin the encrypted report");
  return body;
}

/** Fetch an envelope and, if a hash is given, check it against the one recorded on-chain. */
export async function fetchEnvelope(cid, expectedHash) {
  const res = await fetch(`${BACKEND_URL}/api/ipfs/${cid}`);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || "Failed to fetch the encrypted report");
  const bytes = base64ToBytes(body.data);
  if (expectedHash && keccak256(bytes).toLowerCase() !== expectedHash.toLowerCase()) {
    throw new Error("The stored report does not match its on-chain hash — it may have been tampered with.");
  }
  return bytes;
}
