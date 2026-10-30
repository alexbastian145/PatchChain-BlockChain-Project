import { useEffect, useState } from "react";
import { ZeroHash, isAddress } from "ethers";
import { getContracts, errorMessage } from "../utils/contracts";
import { encryptReport } from "../utils/e2ee";
import { pinEnvelope } from "../utils/api";
import { RANKS } from "../config";
import { Alert, CopyButton, Icon, RankBadge, Spinner, formatEth } from "./ui.jsx";

const EMPTY_FORM = {
  organization: "",
  title: "",
  description: "",
  stepsToReproduce: "",
};

export default function SubmitReport({ signer, address, crypto }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [status, setStatus] = useState("idle"); // idle | encrypting | submitting | done | error
  const [message, setMessage] = useState("");
  const [reportId, setReportId] = useState(null);

  const [stake, setStake] = useState(null); // bigint, from the chain
  const [rank, setRank] = useState(0);
  const [orgKey, setOrgKey] = useState(undefined); // undefined = unknown, null = none, string = key

  // What this researcher pays depends on their reputation, so read it from the contract.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { stakeManager, reputation } = getContracts(signer);
        const [required, r] = await Promise.all([
          stakeManager.requiredStakeFor(address),
          reputation.rankOf(address),
        ]);
        if (!cancelled) {
          setStake(required);
          setRank(Number(r));
        }
      } catch {
        /* leave as unknown; submit stays disabled until it loads */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [signer, address, status]);

  // Look up the organization's published encryption key as the address is typed.
  useEffect(() => {
    const org = form.organization.trim();
    if (!isAddress(org)) {
      setOrgKey(undefined);
      return undefined;
    }
    let cancelled = false;
    setOrgKey(undefined);
    (async () => {
      try {
        const { keyRegistry } = getContracts(signer);
        const key = await keyRegistry.publicKeyOf(org);
        if (!cancelled) setOrgKey(key === ZeroHash ? null : key);
      } catch {
        if (!cancelled) setOrgKey(undefined);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [form.organization, signer]);

  function update(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!signer) {
      setMessage("Connect your wallet first.");
      setStatus("error");
      return;
    }

    try {
      const organization = form.organization.trim();
      if (!isAddress(organization)) throw new Error("Enter a valid organization wallet address.");
      if (!orgKey) throw new Error("This organization has not published an encryption key yet.");
      if (stake === null) throw new Error("Still loading your stake amount — try again in a moment.");

      // Step 1: derive our key (a free signature), then encrypt IN THE BROWSER for the
      // organization and for ourselves. The server never sees plaintext or any key.
      setStatus("encrypting");
      setMessage("Sign the message in your wallet to unlock your encryption key…");
      const keys = await crypto.ensureKeys();

      setMessage("Encrypting your report and pinning the ciphertext to IPFS…");
      const { envelopeBytes, reportHash } = encryptReport(
        {
          title: form.title,
          description: form.description,
          stepsToReproduce: form.stepsToReproduce,
          preparedAt: new Date().toISOString(),
        },
        { [organization]: orgKey, [address]: keys.publicKeyHex }
      );
      const pinned = await pinEnvelope(envelopeBytes);
      if (pinned.reportHash.toLowerCase() !== reportHash.toLowerCase()) {
        throw new Error("The pinning service returned a different hash than expected. Nothing was submitted.");
      }

      // Step 2: our own wallet sends the staked transaction — the backend never touches funds.
      setStatus("submitting");
      setMessage(`Confirm the transaction in your wallet (stake: ${formatEth(stake)} ETH)…`);

      const { stakeManager } = getContracts(signer);
      const tx = await stakeManager.submitReportWithStake(organization, reportHash, pinned.cid, {
        value: stake,
      });
      const receipt = await tx.wait();

      const event = receipt.logs
        .map((log) => {
          try {
            return stakeManager.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((parsed) => parsed && parsed.name === "StakeDeposited");

      setReportId(event ? event.args.reportId.toString() : null);
      setStatus("done");
      setMessage("Report encrypted, pinned and recorded on-chain.");
    } catch (err) {
      console.error(err);
      setStatus("error");
      setMessage(errorMessage(err));
    }
  }

  function reset() {
    setForm(EMPTY_FORM);
    setReportId(null);
    setMessage("");
    setStatus("idle");
  }

  const busy = status === "encrypting" || status === "submitting";

  if (status === "done") {
    return (
      <div className="card done-card">
        <span className="done-icon">
          <Icon name="check" size="lg" />
        </span>
        <h2>Report submitted</h2>
        <p>{message} Your stake is held until the organization validates the report.</p>

        {reportId !== null && (
          <div className="idbox">
            <div>
              <small>Report ID</small>
              <strong>#{reportId}</strong>
            </div>
            <CopyButton text={reportId} label="Copy ID" />
          </div>
        )}
        <p className="help-text">
          Only you and the organization can read it. Find it again under My Reports.
        </p>

        <button type="button" className="btn btn-ghost" onClick={reset} style={{ marginTop: 6 }}>
          <Icon name="filePlus" />
          Submit another report
        </button>
      </div>
    );
  }

  const stage = status === "encrypting" ? 0 : status === "submitting" ? 1 : -1;
  const stepClass = (i) => (stage === i ? "active" : stage > i ? "done" : "");
  const orgChecked = isAddress(form.organization.trim());
  const blocked = orgChecked && orgKey === null;

  return (
    <div className="split">
      <form className="card" onSubmit={handleSubmit}>
        <div className="card-head">
          <div>
            <h2>Vulnerability details</h2>
            <p>Encrypted in your browser before it leaves your device — only a hash goes on-chain.</p>
          </div>
        </div>

        <div className="field">
          <label htmlFor="org">Organization wallet address</label>
          <input
            id="org"
            className="input mono"
            type="text"
            placeholder="0x…"
            autoComplete="off"
            spellCheck={false}
            value={form.organization}
            onChange={(e) => update("organization", e.target.value)}
            required
          />
          {orgChecked && orgKey && (
            <span className="help ok">
              <Icon name="lock" size="sm" /> Encryption key found — the report will be readable only by them and you.
            </span>
          )}
          {!orgChecked && (
            <span className="help">The organization that will validate the report and pay the bounty.</span>
          )}
        </div>

        {blocked && (
          <div style={{ marginTop: 14 }}>
            <Alert tone="warn">
              This organization hasn't published an encryption key, so a report can't be encrypted for
              them. Ask them to open their dashboard and click <strong>Create &amp; publish key</strong>.
            </Alert>
          </div>
        )}

        <div className="field">
          <label htmlFor="title">Vulnerability title</label>
          <input
            id="title"
            className="input"
            type="text"
            placeholder="e.g. Stored XSS in profile bio field"
            value={form.title}
            onChange={(e) => update("title", e.target.value)}
            required
          />
        </div>

        <div className="field">
          <label htmlFor="desc">Description</label>
          <textarea
            id="desc"
            className="textarea"
            placeholder="Describe the vulnerability, its impact, and the affected component."
            value={form.description}
            onChange={(e) => update("description", e.target.value)}
            required
          />
        </div>

        <div className="field">
          <label htmlFor="steps">
            Steps to reproduce <span className="opt">optional</span>
          </label>
          <textarea
            id="steps"
            className="textarea"
            placeholder={"1. Navigate to…\n2. Submit…\n3. Observe…"}
            value={form.stepsToReproduce}
            onChange={(e) => update("stepsToReproduce", e.target.value)}
          />
        </div>

        {message && (status === "error" || busy) && (
          <div style={{ marginTop: 16 }}>
            <Alert tone={status === "error" ? "error" : "info"} busy={busy}>
              {message}
            </Alert>
          </div>
        )}

        <button
          type="submit"
          className="btn btn-primary block"
          style={{ marginTop: 20 }}
          disabled={busy || blocked || stake === null}
        >
          {busy ? (
            <>
              <Spinner /> Processing…
            </>
          ) : (
            <>
              <Icon name="lock" /> Encrypt &amp; submit · stake {stake === null ? "…" : formatEth(stake)} ETH
            </>
          )}
        </button>
      </form>

      <aside className="stack sticky">
        <div className="stake">
          <span className="stat-icon">
            <Icon name="coins" />
          </span>
          <div>
            <div className="stake-value">
              {stake === null ? "…" : formatEth(stake)}
              <small>ETH stake</small>
            </div>
            <p>
              <RankBadge rank={rank} />{" "}
              {rank > 0
                ? `${RANKS[rank].discount} off thanks to your reputation.`
                : "Earn reputation to lower your stake."}
            </p>
          </div>
        </div>

        <div className="card">
          <div className="card-head" style={{ marginBottom: 16 }}>
            <div>
              <h2>How it works</h2>
            </div>
          </div>
          <ol className="timeline">
            <li className={stepClass(0)}>
              <span className="tl-dot">{stage > 0 ? <Icon name="check" size="sm" /> : 1}</span>
              <div>
                <strong>Encrypt &amp; pin</strong>
                <span>Encrypted in your browser to the organization's key, then the ciphertext is pinned to IPFS.</span>
              </div>
            </li>
            <li className={stepClass(1)}>
              <span className="tl-dot">{stage > 1 ? <Icon name="check" size="sm" /> : 2}</span>
              <div>
                <strong>Stake &amp; sign</strong>
                <span>You confirm the staked transaction from your own wallet.</span>
              </div>
            </li>
            <li className={stepClass(2)}>
              <span className="tl-dot">3</span>
              <div>
                <strong>Anchored on-chain</strong>
                <span>Hash and timestamp are recorded as proof you found it first.</span>
              </div>
            </li>
          </ol>
        </div>
      </aside>
    </div>
  );
}
