import { useCallback, useEffect, useRef, useState } from "react";
import { KEY_DERIVATION_MESSAGE, deriveKeyPair } from "./e2ee";

/**
 * Holds the user's encryption keypair for the session. The key is derived from a wallet
 * signature (no gas, nothing stored) and kept only in memory — a page refresh means signing
 * once more, which yields the identical key.
 */
export function useCrypto(signer, address) {
  const [keys, setKeys] = useState(null);
  const [busy, setBusy] = useState(false);
  const keysRef = useRef(null);

  useEffect(() => {
    keysRef.current = null;
    setKeys(null);
  }, [address]);

  const ensureKeys = useCallback(async () => {
    if (keysRef.current) return keysRef.current;
    if (!signer) throw new Error("Connect your wallet first.");
    setBusy(true);
    try {
      const signature = await signer.signMessage(KEY_DERIVATION_MESSAGE);
      const derived = deriveKeyPair(signature);
      keysRef.current = derived;
      setKeys(derived);
      return derived;
    } finally {
      setBusy(false);
    }
  }, [signer]);

  return { keys, ensureKeys, busy };
}
