import { useCallback, useEffect, useState } from "react";
import { ZeroHash } from "ethers";
import { getContracts, errorMessage } from "../utils/contracts";
import { Alert, Icon, Spinner } from "./ui.jsx";

/**
 * Lets the user publish (and later unlock) their report-encryption key.
 * The key is derived from a wallet signature — there is nothing to back up.
 * `onChange` receives { registered, matches } so parent pages can gate features.
 */
export default function EncryptionKeyCard({ signer, address, crypto, title, blurb, onChange }) {
  const [onChain, setOnChain] = useState(undefined); // undefined = loading, null = none
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const { keyRegistry } = getContracts(signer);
      const key = await keyRegistry.publicKeyOf(address);
      setOnChain(key === ZeroHash ? null : key);
    } catch (err) {
      setError(errorMessage(err));
      setOnChain(null);
    }
  }, [signer, address]);

  useEffect(() => {
    load();
  }, [load]);

  const matches = Boolean(
    onChain && crypto.keys && crypto.keys.publicKeyHex.toLowerCase() === onChain.toLowerCase()
  );

  useEffect(() => {
    onChange?.({ registered: Boolean(onChain), matches });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onChain, matches]);

  async function publish() {
    setBusy(true);
    setError("");
    try {
      const keys = await crypto.ensureKeys();
      const { keyRegistry } = getContracts(signer);
      const tx = await keyRegistry.registerKey(keys.publicKeyHex);
      await tx.wait();
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function unlock() {
    setBusy(true);
    setError("");
    try {
      await crypto.ensureKeys();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const loading = onChain === undefined;

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>{title || "Encryption key"}</h2>
          <p>
            {blurb ||
              "Reports are encrypted to this key in the researcher's browser, so no server ever sees them."}
          </p>
        </div>
        <span className="stat-icon" style={{ "--tone": matches ? "var(--success)" : "var(--violet-300)" }}>
          <Icon name={matches ? "unlock" : "key"} />
        </span>
      </div>

      {error && (
        <div style={{ marginBottom: 14 }}>
          <Alert tone="error">{error}</Alert>
        </div>
      )}

      {loading ? (
        <p className="help-text">Checking the key registry…</p>
      ) : !onChain ? (
        <>
          <Alert tone="warn">
            You haven't published an encryption key yet. Until you do, nobody can send you an
            encrypted report.
          </Alert>
          <button type="button" className="btn btn-primary block" style={{ marginTop: 14 }} onClick={publish} disabled={busy}>
            {busy ? <Spinner /> : <Icon name="key" />}
            Create &amp; publish key
          </button>
          <p className="help-text">
            You'll sign a message (free) to derive the key, then confirm one small transaction to
            publish its public half.
          </p>
        </>
      ) : !crypto.keys ? (
        <>
          <div className="keyline">
            <span className="label">Published key</span>
            <span className="mono">{onChain.slice(0, 18)}…{onChain.slice(-6)}</span>
          </div>
          <button type="button" className="btn btn-ghost block" style={{ marginTop: 14 }} onClick={unlock} disabled={busy}>
            {busy ? <Spinner /> : <Icon name="unlock" />}
            Unlock to read reports
          </button>
          <p className="help-text">Sign once per session to derive your key. Nothing is sent anywhere.</p>
        </>
      ) : matches ? (
        <>
          <div className="keyline">
            <span className="label">Published key</span>
            <span className="mono">{onChain.slice(0, 18)}…{onChain.slice(-6)}</span>
          </div>
          <Alert tone="success">Unlocked. Your wallet key matches the one published on-chain.</Alert>
        </>
      ) : (
        <>
          <Alert tone="warn">
            The key published on-chain doesn't match the one your wallet just derived. Publish the
            current key to replace it — reports already encrypted to the old key stay readable only
            by whoever holds it.
          </Alert>
          <button type="button" className="btn btn-primary block" style={{ marginTop: 14 }} onClick={publish} disabled={busy}>
            {busy ? <Spinner /> : <Icon name="key" />}
            Replace published key
          </button>
        </>
      )}
    </section>
  );
}
