import { useState } from "react";
import { parseEther } from "ethers";
import { getContracts } from "../utils/contracts";
import { BACKEND_URL, REQUIRED_STAKE_ETH } from "../config";
import { Alert, CopyButton, Icon, Spinner } from "./ui.jsx";

const EMPTY_FORM = {
  organization: "",
  title: "",
  description: "",
  stepsToReproduce: "",
};

export default function SubmitReport({ signer }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [status, setStatus] = useState("idle"); // idle | preparing | submitting | done | error
  const [message, setMessage] = useState("");
  const [reportId, setReportId] = useState(null);

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
      // Step 1: backend encrypts the report and uploads the ciphertext to IPFS,
      // returning the hash + CID the contract call needs.
      setStatus("preparing");
      setMessage("Encrypting report and uploading to IPFS...");

      const prepRes = await fetch(`${BACKEND_URL}/api/reports/prepare`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const prepData = await prepRes.json();
      if (!prepRes.ok) throw new Error(prepData.error || "Failed to prepare report");

      // Step 2: researcher's own wallet sends the staked submission transaction —
      // the backend never touches researcher funds.
      setStatus("submitting");
      setMessage("Confirm the transaction in MetaMask (stake: " + REQUIRED_STAKE_ETH + " ETH)...");

      const { stakeManager } = getContracts(signer);
      const tx = await stakeManager.submitReportWithStake(
        prepData.organization,
        prepData.reportHash,
        prepData.cid,
        { value: parseEther(REQUIRED_STAKE_ETH) }
      );
      const receipt = await tx.wait();

      // Pull the reportId out of the StakeDeposited event emitted by the stake manager.
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
      setMessage("Report submitted and recorded on-chain.");
    } catch (err) {
      console.error(err);
      setStatus("error");
      setMessage(err.message || "Submission failed");
    }
  }

  function reset() {
    setForm(EMPTY_FORM);
    setReportId(null);
    setMessage("");
    setStatus("idle");
  }

  const busy = status === "preparing" || status === "submitting";

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
        <p className="help" style={{ fontSize: "0.8rem", color: "var(--faint)" }}>
          Keep this ID — you'll use it to track the report under My Reports.
        </p>

        <button type="button" className="btn btn-ghost" onClick={reset} style={{ marginTop: 6 }}>
          <Icon name="filePlus" />
          Submit another report
        </button>
      </div>
    );
  }

  // Timeline state: which stage is running / finished.
  const stage = status === "preparing" ? 0 : status === "submitting" ? 1 : -1;
  const stepClass = (i) => (stage === i ? "active" : stage > i ? "done" : "");

  return (
    <div className="split">
      <form className="card" onSubmit={handleSubmit}>
        <div className="card-head">
          <div>
            <h2>Vulnerability details</h2>
            <p>The content is encrypted before it leaves your session — only a hash goes on-chain.</p>
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
          <span className="help">The organization that will validate the report and pay the bounty.</span>
        </div>

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
          disabled={busy}
        >
          {busy ? (
            <>
              <Spinner /> Processing…
            </>
          ) : (
            <>
              <Icon name="lock" /> Encrypt &amp; submit · stake {REQUIRED_STAKE_ETH} ETH
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
              {REQUIRED_STAKE_ETH}
              <small>ETH stake</small>
            </div>
            <p>Refunded once the organization validates your report.</p>
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
                <span>The report is encrypted and the ciphertext is uploaded to IPFS.</span>
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
