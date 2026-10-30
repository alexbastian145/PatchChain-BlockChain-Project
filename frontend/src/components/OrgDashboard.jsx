import { useEffect, useState } from "react";
import { formatEther, parseEther } from "ethers";
import { getContracts, errorMessage } from "../utils/contracts";
import { decryptReport } from "../utils/e2ee";
import { fetchEnvelope } from "../utils/api";
import { BACKEND_URL, SEVERITY_LABELS } from "../config";
import EncryptionKeyCard from "./EncryptionKeyCard.jsx";
import {
  Alert,
  Empty,
  Icon,
  Modal,
  ReportView,
  SkeletonRows,
  Spinner,
  Stat,
  StatusBadge,
  formatDate,
  shortAddr,
} from "./ui.jsx";

const QUICK_AMOUNTS = ["0.1", "0.5", "1", "5"];

export default function OrgDashboard({ signer, address, crypto }) {
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [fundAmount, setFundAmount] = useState("0.5");
  const [notice, setNotice] = useState(null); // { tone: info|success|error, text }
  const [busyKey, setBusyKey] = useState(null);
  const [viewing, setViewing] = useState(null); // { id, content }
  const [tiers, setTiers] = useState({ 1: "", 2: "", 3: "", 4: "" });
  const [savedTiers, setSavedTiers] = useState({ 1: "", 2: "", 3: "", 4: "" });

  async function loadTiers() {
    try {
      const { escrow } = getContracts(signer);
      const values = await Promise.all([1, 2, 3, 4].map((l) => escrow.bountyTiers(address, l)));
      const next = {};
      values.forEach((v, i) => {
        next[i + 1] = v === 0n ? "" : formatEther(v);
      });
      setTiers(next);
      setSavedTiers(next);
    } catch {
      /* tiers stay blank */
    }
  }

  async function loadReports() {
    if (!address) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${BACKEND_URL}/api/organizations/${address}/reports`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load reports");
      setReports(data.reports);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadReports();
    loadTiers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  // Runs a wallet action with consistent pending / success / error feedback.
  async function run(key, pendingText, action, successText, { reload = false } = {}) {
    setBusyKey(key);
    setNotice({ tone: "info", text: pendingText });
    try {
      await action();
      setNotice({ tone: "success", text: successText });
      if (reload) loadReports();
    } catch (err) {
      setNotice({ tone: "error", text: errorMessage(err) });
    } finally {
      setBusyKey(null);
    }
  }

  function handleRead(report) {
    return run(
      `read-${report.reportId}`,
      "Unlocking your key and decrypting…",
      async () => {
        const keys = await crypto.ensureKeys();
        const bytes = await fetchEnvelope(report.ipfsCID, report.reportHash);
        setViewing({ id: report.reportId, content: decryptReport(bytes, address, keys.secretKey) });
      },
      `Report #${report.reportId} decrypted in your browser.`
    );
  }

  function handleSaveTiers() {
    return run(
      "tiers",
      "Saving bounty tiers…",
      async () => {
        const { escrow } = getContracts(signer);
        for (const level of [1, 2, 3, 4]) {
          if (tiers[level] !== "" && tiers[level] !== savedTiers[level]) {
            const tx = await escrow.setBountyTier(level, parseEther(tiers[level]));
            await tx.wait();
          }
        }
        await loadTiers();
      },
      "Bounty tiers saved."
    );
  }

  function handleFund() {
    return run(
      "fund",
      "Funding escrow…",
      async () => {
        const { escrow } = getContracts(signer);
        const tx = await escrow.fund({ value: parseEther(fundAmount) });
        await tx.wait();
      },
      `Funded escrow with ${fundAmount} ETH.`
    );
  }

  function handleApprove(reportId, severity) {
    return run(
      `approve-${reportId}`,
      `Approving report #${reportId} at severity ${SEVERITY_LABELS[severity]}…`,
      async () => {
        const { escrow } = getContracts(signer);
        const tx = await escrow.approveAndPay(reportId, severity);
        await tx.wait();
      },
      `Report #${reportId} approved and paid.`,
      { reload: true }
    );
  }

  function handleRefundStake(reportId) {
    return run(
      `refund-${reportId}`,
      `Refunding stake for report #${reportId}…`,
      async () => {
        const { stakeManager } = getContracts(signer);
        const tx = await stakeManager.refundStake(reportId);
        await tx.wait();
      },
      `Stake refunded for report #${reportId}.`
    );
  }

  function handleDispute(reportId) {
    return run(
      `dispute-${reportId}`,
      `Raising dispute for report #${reportId}…`,
      async () => {
        const { escrow } = getContracts(signer);
        const tx = await escrow.raiseDispute(reportId);
        await tx.wait();
      },
      `Dispute raised for report #${reportId}.`,
      { reload: true }
    );
  }

  const count = (...statuses) => reports.filter((r) => statuses.includes(r.status)).length;
  const amountValid = fundAmount.trim() !== "" && Number(fundAmount) > 0;
  const anyTierBusy = Boolean(busyKey);

  return (
    <>
      <div className="stats three">
        <Stat icon="inbox" value={reports.length} label="Incoming reports" />
        <Stat
          icon="clock"
          value={count("Submitted")}
          label="Awaiting your review"
          tone="var(--warning)"
        />
        <Stat icon="check" value={count("Validated")} label="Validated" tone="var(--success)" />
      </div>

      {notice && (
        <Alert
          tone={notice.tone}
          busy={Boolean(busyKey) && notice.tone === "info"}
          onDismiss={busyKey ? undefined : () => setNotice(null)}
        >
          {notice.text}
        </Alert>
      )}

      <div className="split">
        <section className="card flush">
          <div className="card-head">
            <div>
              <h2>Incoming reports</h2>
              <p>Assign a severity to approve a payout, or raise a dispute.</p>
            </div>
            <button
              type="button"
              className="btn btn-ghost sm"
              onClick={loadReports}
              disabled={loading}
            >
              <Icon name="refresh" size="sm" />
              Refresh
            </button>
          </div>

          {error && (
            <div style={{ padding: "16px 22px 0" }}>
              <Alert tone="error">{error}</Alert>
            </div>
          )}

          {loading && reports.length === 0 ? (
            <SkeletonRows />
          ) : reports.length === 0 && !error ? (
            <Empty title="No reports yet">
              When researchers submit reports to your organization they'll appear here.
            </Empty>
          ) : (
            <div className="report-list">
              {reports.map((r) => (
                <ReportRow
                  key={r.reportId}
                  report={r}
                  busyKey={busyKey}
                  onRead={handleRead}
                  onApprove={handleApprove}
                  onRefundStake={handleRefundStake}
                  onDispute={handleDispute}
                />
              ))}
            </div>
          )}
        </section>

        <aside className="stack">
          <EncryptionKeyCard signer={signer} address={address} crypto={crypto} />

          <section className="card">
            <div className="card-head">
              <div>
                <h2>Bounty tiers</h2>
                <p>What you pay per severity. Required before you can approve a report.</p>
              </div>
              <span className="stat-icon">
                <Icon name="award" />
              </span>
            </div>
            <div className="tier-grid">
              {[1, 2, 3, 4].map((level) => (
                <div className="field" key={level}>
                  <label htmlFor={`tier-${level}`}>{SEVERITY_LABELS[level]}</label>
                  <div className="input-group">
                    <input
                      id={`tier-${level}`}
                      className="input mono"
                      inputMode="decimal"
                      placeholder="0.0"
                      value={tiers[level]}
                      onChange={(e) => setTiers((t) => ({ ...t, [level]: e.target.value }))}
                    />
                    <span className="suffix">ETH</span>
                  </div>
                </div>
              ))}
            </div>
            <button
              type="button"
              className="btn btn-ghost block"
              style={{ marginTop: 16 }}
              onClick={handleSaveTiers}
              disabled={anyTierBusy || JSON.stringify(tiers) === JSON.stringify(savedTiers)}
            >
              {busyKey === "tiers" ? <Spinner /> : <Icon name="check" size="sm" />}
              Save tiers
            </button>
          </section>

          <section className="card">
            <div className="card-head">
              <div>
                <h2>Fund bounty escrow</h2>
                <p>Deposit ETH into your organization's bounty pool.</p>
              </div>
              <span className="stat-icon">
                <Icon name="coins" />
              </span>
            </div>

            <div className="field">
              <label htmlFor="fund">Amount</label>
              <div className="input-group">
                <input
                  id="fund"
                  className="input mono"
                  inputMode="decimal"
                  value={fundAmount}
                  onChange={(e) => setFundAmount(e.target.value)}
                />
                <span className="suffix">ETH</span>
              </div>
            </div>

            <div className="chips" style={{ marginTop: 10 }}>
              {QUICK_AMOUNTS.map((amt) => (
                <button
                  key={amt}
                  type="button"
                  className={`chip ${fundAmount === amt ? "on" : ""}`}
                  onClick={() => setFundAmount(amt)}
                >
                  {amt} ETH
                </button>
              ))}
            </div>

            <button
              type="button"
              className="btn btn-primary block"
              style={{ marginTop: 18 }}
              onClick={handleFund}
              disabled={!amountValid || busyKey === "fund"}
            >
              {busyKey === "fund" ? (
                <>
                  <Spinner /> Funding…
                </>
              ) : (
                <>
                  <Icon name="coins" /> Fund escrow
                </>
              )}
            </button>
          </section>
        </aside>
      </div>

      {viewing && (
        <Modal
          title={`Report #${viewing.id}`}
          subtitle="Decrypted locally — this content never touched a server in readable form."
          onClose={() => setViewing(null)}
        >
          <ReportView report={viewing.content} />
        </Modal>
      )}
    </>
  );
}

function ReportRow({ report, busyKey, onRead, onApprove, onRefundStake, onDispute }) {
  const [severity, setSeverity] = useState(3);
  const anyBusy = Boolean(busyKey);
  const id = report.reportId;

  return (
    <article className="report">
      <div className="report-top">
        <span className="report-icon">
          <Icon name="shield" />
        </span>
        <div className="report-main">
          <h3>
            Report <span className="mono">#{id}</span>
          </h3>
          <div className="meta">
            <span>
              <Icon name="user" size="sm" />
              <span className="mono">{shortAddr(report.researcher)}</span>
            </span>
            <span>
              <Icon name="clock" size="sm" />
              {formatDate(report.submittedAt)}
            </span>
          </div>
        </div>
        <StatusBadge status={report.status} />
      </div>

      <div className="row-actions">
        <button type="button" className="btn btn-ghost sm" onClick={() => onRead(report)} disabled={anyBusy}>
          {busyKey === `read-${id}` ? <Spinner /> : <Icon name="unlock" size="sm" />}
          Decrypt &amp; read
        </button>
      </div>

      {report.status === "Submitted" && (
        <div className="report-actions">
          <span className="label">Severity &amp; payout tier</span>
          <div className="sev" role="radiogroup" aria-label="Severity">
            {[1, 2, 3, 4].map((level) => (
              <button
                key={level}
                type="button"
                role="radio"
                aria-checked={severity === level}
                className={`sev-${SEVERITY_LABELS[level].toLowerCase()} ${
                  severity === level ? "on" : ""
                }`}
                onClick={() => setSeverity(level)}
              >
                {SEVERITY_LABELS[level]}
              </button>
            ))}
          </div>
          <div className="row">
            <button
              type="button"
              className="btn btn-success sm"
              onClick={() => onApprove(id, severity)}
              disabled={anyBusy}
            >
              {busyKey === `approve-${id}` ? <Spinner /> : <Icon name="check" size="sm" />}
              Approve &amp; pay
            </button>
            <button
              type="button"
              className="btn btn-danger sm"
              onClick={() => onDispute(id)}
              disabled={anyBusy}
            >
              {busyKey === `dispute-${id}` ? <Spinner /> : <Icon name="alert" size="sm" />}
              Raise dispute
            </button>
          </div>
        </div>
      )}

      {report.status === "Validated" && (
        <div className="report-actions">
          <div className="row">
            <button
              type="button"
              className="btn btn-ghost sm"
              onClick={() => onRefundStake(id)}
              disabled={anyBusy}
            >
              {busyKey === `refund-${id}` ? <Spinner /> : <Icon name="coins" size="sm" />}
              Refund researcher stake
            </button>
          </div>
        </div>
      )}
    </article>
  );
}
