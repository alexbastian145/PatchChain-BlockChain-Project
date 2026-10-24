import { useEffect, useState } from "react";
import { BACKEND_URL } from "../config";
import {
  Alert,
  Empty,
  Icon,
  SkeletonRows,
  Stat,
  StatusBadge,
  formatDate,
  shortAddr,
} from "./ui.jsx";

export default function MyReports({ address, onSubmitNew }) {
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    if (!address) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${BACKEND_URL}/api/researchers/${address}/reports`);
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
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  const count = (...statuses) => reports.filter((r) => statuses.includes(r.status)).length;

  return (
    <>
      <div className="stats">
        <Stat icon="clipboard" value={reports.length} label="Total reports" />
        <Stat
          icon="clock"
          value={count("Submitted", "UnderReview")}
          label="In review"
          tone="var(--warning)"
        />
        <Stat icon="check" value={count("Validated")} label="Validated" tone="var(--success)" />
        <Stat icon="ban" value={count("Rejected")} label="Rejected" tone="var(--danger)" />
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      <section className="card flush">
        <div className="card-head">
          <div>
            <h2>Submitted reports</h2>
            <p>Everything you've filed from this wallet.</p>
          </div>
          <button type="button" className="btn btn-ghost sm" onClick={load} disabled={loading}>
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
            {reports.map((r) => (
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
                    </div>
                  </div>
                  <StatusBadge status={r.status} />
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
