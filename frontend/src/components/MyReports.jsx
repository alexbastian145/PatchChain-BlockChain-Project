import { useEffect, useState } from "react";
import { hexlify } from "ethers";
import { BACKEND_URL } from "../config";
import { getContracts, errorMessage } from "../utils/contracts";
import { decryptReport, decryptWithContentKey, unlockContentKey } from "../utils/e2ee";
import { fetchEnvelope } from "../utils/api";
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

const PAYOUT = { NotPaid: 0, Paid: 1, Disputed: 2 };

function formatRemaining(seconds) {
  if (seconds <= 0) return "deadline passed";
  const d = Math.floor(seconds / 86400);
  if (d >= 1) return `${d}d ${Math.floor((seconds % 86400) / 3600)}h left`;
  const h = Math.floor(seconds / 3600);
  return h >= 1 ? `${h}h ${Math.floor((seconds % 3600) / 60)}m left` : `${Math.max(1, Math.floor(seconds / 60))}m left`;
}

export default function MyReports({ address, signer, crypto, onSubmitNew, onGoArbitration }) {
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(null);
  const [busyKey, setBusyKey] = useState(null);
  const [viewing, setViewing] = useState(null); // { id, content }

  async function load() {
    if (!address) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${BACKEND_URL}/api/researchers/${address}/reports`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load reports");

      // Enrich each report with on-chain settlement + disclosure state.
      const { escrow, timer } = getContracts(signer);
      const enriched = await Promise.all(
        data.reports.map(async (r) => {
          const [payout, deadline, remaining, keyPublished] = await Promise.all([
            escrow.payoutState(r.reportId),
            timer.deadline(r.reportId),
            timer.timeRemaining(r.reportId),
            timer.keyPublished(r.reportId),
          ]);
          return {
            ...r,
            payout: Number(payout),
            timerStarted: deadline > 0n,
            secondsRemaining: Number(remaining),
            keyPublished,
          };
        })
      );
      setReports(enriched);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  async function run(key, pending, action, success) {
    setBusyKey(key);
    setNotice({ tone: "info", text: pending });
    try {
      await action();
      setNotice({ tone: "success", text: success });
      await load();
    } catch (err) {
      setNotice({ tone: "error", text: errorMessage(err) });
    } finally {
      setBusyKey(null);
    }
  }

  const read = (r) =>
    run(
      `read-${r.reportId}`,
      "Unlocking your key and decrypting…",
      async () => {
        const keys = await crypto.ensureKeys();
        const bytes = await fetchEnvelope(r.ipfsCID, r.reportHash);
        setViewing({ id: r.reportId, content: decryptReport(bytes, address, keys.secretKey) });
      },
      `Report #${r.reportId} decrypted in your browser.`
    );

  const readPublic = (r) =>
    run(
      `read-${r.reportId}`,
      "Fetching the public report…",
      async () => {
        const { timer } = getContracts(signer);
        const key = await timer.disclosureKey(r.reportId);
        const bytes = await fetchEnvelope(r.ipfsCID, r.reportHash);
        setViewing({ id: r.reportId, content: decryptWithContentKey(bytes, key) });
      },
      `Public report #${r.reportId} decrypted.`
    );

  const startTimer = (r) =>
    run(
      `timer-${r.reportId}`,
      "Starting the disclosure countdown…",
      async () => {
        const { timer } = getContracts(signer);
        await (await timer.startTimer(r.reportId)).wait();
      },
      `Countdown started for report #${r.reportId}. It will auto-disclose if the organization doesn't act.`
    );

  const triggerDisclosure = (r) =>
    run(
      `disclose-${r.reportId}`,
      "Disclosing the report…",
      async () => {
        const { timer } = getContracts(signer);
        await (await timer.triggerAutoDisclosure(r.reportId)).wait();
      },
      `Report #${r.reportId} is now marked Disclosed.`
    );

  const publishKey = (r) =>
    run(
      `key-${r.reportId}`,
      "Unlocking the report key and publishing it on-chain…",
      async () => {
        const keys = await crypto.ensureKeys();
        const bytes = await fetchEnvelope(r.ipfsCID, r.reportHash);
        const contentKey = hexlify(unlockContentKey(bytes, address, keys.secretKey));
        const { timer } = getContracts(signer);
        await (await timer.publishDisclosureKey(r.reportId, contentKey)).wait();
      },
      `Report #${r.reportId} is now publicly readable.`
    );

  const dispute = (r) =>
    run(
      `dispute-${r.reportId}`,
      `Raising a dispute for report #${r.reportId}…`,
      async () => {
        const { escrow } = getContracts(signer);
        await (await escrow.raiseDispute(r.reportId)).wait();
      },
      `Dispute raised for report #${r.reportId}. Open it in Arbitration to bring in a jury.`
    );

  const count = (...statuses) => reports.filter((r) => statuses.includes(r.status)).length;
  const anyBusy = Boolean(busyKey);

  return (
    <>
      <div className="stats">
        <Stat icon="clipboard" value={reports.length} label="Total reports" />
        <Stat icon="clock" value={count("Submitted", "UnderReview")} label="In review" tone="var(--warning)" />
        <Stat icon="check" value={count("Validated")} label="Validated" tone="var(--success)" />
        <Stat icon="ban" value={count("Rejected")} label="Rejected" tone="var(--danger)" />
      </div>

      {notice && (
        <Alert
          tone={notice.tone}
          busy={anyBusy && notice.tone === "info"}
          onDismiss={anyBusy ? undefined : () => setNotice(null)}
        >
          {notice.text}
        </Alert>
      )}
      {error && <Alert tone="error">{error}</Alert>}

      <section className="card flush">
        <div className="card-head">
          <div>
            <h2>Submitted reports</h2>
            <p>Everything you've filed from this wallet.</p>
          </div>
          <button type="button" className="btn btn-ghost sm" onClick={load} disabled={loading || anyBusy}>
            <Icon name="refresh" size="sm" />
            Refresh
          </button>
        </div>

        {loading && reports.length === 0 ? (
          <SkeletonRows />
        ) : reports.length === 0 && !error ? (
          <Empty
            title="No reports yet"
            action={
              onSubmitNew && (
                <button type="button" className="btn btn-primary" onClick={onSubmitNew}>
                  <Icon name="filePlus" />
                  Submit your first report
                </button>
              )
            }
          >
            Reports you submit will show up here with their live on-chain status.
          </Empty>
        ) : (
          <div className="report-list">
            {reports.map((r) => {
              const disputed = r.payout === PAYOUT.Disputed;
              const open = r.status === "Submitted" || r.status === "UnderReview";
              return (
                <article className="report" key={r.reportId}>
                  <div className="report-top">
                    <span className="report-icon">
                      <Icon name="shield" />
                    </span>
                    <div className="report-main">
                      <h3>
                        Report <span className="mono">#{r.reportId}</span>
                      </h3>
                      <div className="meta">
                        <span>
                          <Icon name="building" size="sm" />
                          <span className="mono">{shortAddr(r.organization)}</span>
                        </span>
                        <span>
                          <Icon name="clock" size="sm" />
                          {formatDate(r.submittedAt)}
                        </span>
                        {open && r.timerStarted && !disputed && (
                          <span>
                            <Icon name="eye" size="sm" />
                            Auto-disclosure: {formatRemaining(r.secondsRemaining)}
                          </span>
                        )}
                      </div>
                    </div>
                    {disputed && <span className="badge" style={{ "--tone": "var(--warning)" }}>Disputed</span>}
                    <StatusBadge status={r.status} />
                  </div>

                  <div className="row-actions">
                    {r.status === "Disclosed" && r.keyPublished ? (
                      <button type="button" className="btn btn-ghost sm" onClick={() => readPublic(r)} disabled={anyBusy}>
                        {busyKey === `read-${r.reportId}` ? <Spinner /> : <Icon name="eye" size="sm" />}
                        Read public report
                      </button>
                    ) : (
                      <button type="button" className="btn btn-ghost sm" onClick={() => read(r)} disabled={anyBusy}>
                        {busyKey === `read-${r.reportId}` ? <Spinner /> : <Icon name="unlock" size="sm" />}
                        Decrypt &amp; read
                      </button>
                    )}

                    {r.status === "Disclosed" && !r.keyPublished && (
                      <button type="button" className="btn btn-primary sm" onClick={() => publishKey(r)} disabled={anyBusy}>
                        {busyKey === `key-${r.reportId}` ? <Spinner /> : <Icon name="key" size="sm" />}
                        Publish disclosure key
                      </button>
                    )}

                    {open && !disputed && !r.timerStarted && (
                      <button type="button" className="btn btn-ghost sm" onClick={() => startTimer(r)} disabled={anyBusy}>
                        {busyKey === `timer-${r.reportId}` ? <Spinner /> : <Icon name="clock" size="sm" />}
                        Start disclosure countdown
                      </button>
                    )}

                    {open && !disputed && r.timerStarted && r.secondsRemaining === 0 && (
                      <button type="button" className="btn btn-primary sm" onClick={() => triggerDisclosure(r)} disabled={anyBusy}>
                        {busyKey === `disclose-${r.reportId}` ? <Spinner /> : <Icon name="eye" size="sm" />}
                        Disclose now
                      </button>
                    )}

                    {open && !disputed && (
                      <button type="button" className="btn btn-danger sm" onClick={() => dispute(r)} disabled={anyBusy}>
                        {busyKey === `dispute-${r.reportId}` ? <Spinner /> : <Icon name="alert" size="sm" />}
                        Raise dispute
                      </button>
                    )}

                    {disputed && onGoArbitration && (
                      <button type="button" className="btn btn-ghost sm" onClick={onGoArbitration}>
                        <Icon name="scale" size="sm" />
                        Go to arbitration
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

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
