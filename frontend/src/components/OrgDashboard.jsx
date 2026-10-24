import { useEffect, useState } from "react";
import { parseEther } from "ethers";
import { getContracts } from "../utils/contracts";
import { BACKEND_URL, SEVERITY_LABELS } from "../config";
import {
  Alert,
  Empty,
  Icon,
  SkeletonRows,
  Spinner,
  Stat,
  StatusBadge,
  formatDate,
  shortAddr,
} from "./ui.jsx";

const QUICK_AMOUNTS = ["0.1", "0.5", "1", "5"];

export default function OrgDashboard({ signer, address }) {
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [fundAmount, setFundAmount] = useState("0.5");
  const [notice, setNotice] = useState(null); // { tone: info|success|error, text }
  const [busyKey, setBusyKey] = useState(null);

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
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadReports();
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
      setNotice({ tone: "error", text: err.message });
    } finally {
      setBusyKey(null);
    }
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
                  onApprove={handleApprove}
                  onRefundStake={handleRefundStake}
                  onDispute={handleDispute}
                />
              ))}
            </div>
          )}
        </section>

        <aside className="stack sticky">
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
    </>
  );
}

function ReportRow({ report, busyKey, onApprove, onRefundStake, onDispute }) {
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
