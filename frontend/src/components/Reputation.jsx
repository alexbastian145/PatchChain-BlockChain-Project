import { useCallback, useEffect, useState } from "react";
import { toUtf8String } from "ethers";
import { RANKS } from "../config";
import { getContracts, errorMessage } from "../utils/contracts";
import { base64ToBytes } from "../utils/e2ee";
import {
  Alert,
  Empty,
  Icon,
  RANK_TONES,
  RankBadge,
  Spinner,
  Stat,
  formatEth,
  shortAddr,
} from "./ui.jsx";

/** tokenURI is a data: URL holding JSON whose `image` is a data: SVG — all generated on-chain. */
function decodeTokenUri(uri) {
  const json = JSON.parse(toUtf8String(base64ToBytes(uri.split(",")[1])));
  return json;
}

export default function Reputation({ signer, address }) {
  const [data, setData] = useState(null);
  const [badge, setBadge] = useState(null); // decoded metadata
  const [board, setBoard] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(null);

  const load = useCallback(async () => {
    setError("");
    try {
      const { reputation, stakeManager } = getContracts(signer);
      const [tokenId, profile, rank, stake, baseStake] = await Promise.all([
        reputation.tokenIdOf(address),
        reputation.profileOf(address),
        reputation.rankOf(address),
        stakeManager.requiredStakeFor(address),
        stakeManager.requiredStake(),
      ]);

      setData({
        tokenId: Number(tokenId),
        score: Number(profile.score),
        validated: Number(profile.validated),
        rejected: Number(profile.rejected),
        severities: [profile.low, profile.medium, profile.high, profile.critical].map(Number),
        rank: Number(rank),
        stake,
        baseStake,
      });

      setBadge(tokenId > 0n ? decodeTokenUri(await reputation.tokenURI(tokenId)) : null);

      // Leaderboard: replay ReputationUpdated events and keep each researcher's latest score.
      const events = await reputation.queryFilter(reputation.filters.ReputationUpdated(), 0, "latest");
      const latest = new Map();
      for (const ev of events) {
        latest.set(ev.args.researcher, { address: ev.args.researcher, score: Number(ev.args.score), rank: Number(ev.args.rank) });
      }
      setBoard([...latest.values()].sort((a, b) => b.score - a.score).slice(0, 10));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [signer, address]);

  useEffect(() => {
    load();
  }, [load]);

  async function claim() {
    setBusy(true);
    setNotice(null);
    try {
      const { reputation } = getContracts(signer);
      await (await reputation.claim()).wait();
      setNotice({ tone: "success", text: "Badge claimed. It's soulbound — it can never be transferred or sold." });
      await load();
    } catch (err) {
      setNotice({ tone: "error", text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="card">
        <p className="help-text">Reading your reputation from the chain…</p>
      </div>
    );
  }

  if (!data) {
    return error ? <Alert tone="error">{error}</Alert> : null;
  }

  const next = RANKS[data.rank + 1];
  const current = RANKS[data.rank];
  const progress = next
    ? Math.min(100, ((data.score - current.min) / (next.min - current.min)) * 100)
    : 100;

  return (
    <>
      {error && <Alert tone="error">{error}</Alert>}
      {notice && (
        <Alert tone={notice.tone} onDismiss={() => setNotice(null)}>
          {notice.text}
        </Alert>
      )}

      <div className="stats">
        <Stat icon="award" value={data.score} label="Reputation score" />
        <Stat icon="check" value={data.validated} label="Validated reports" tone="var(--success)" />
        <Stat icon="ban" value={data.rejected} label="Rejected / spam" tone="var(--danger)" />
        <Stat icon="coins" value={`${formatEth(data.stake)} ETH`} label="Your stake per report" tone="var(--info)" />
      </div>

      <div className="split">
        <div className="stack">
          <section className="card">
            <div className="card-head">
              <div>
                <h2>Your rank</h2>
                <p>
                  {next
                    ? `${next.min - data.score} more points to reach ${next.name}.`
                    : "You've reached the highest rank."}
                </p>
              </div>
              <RankBadge rank={data.rank} />
            </div>

            <div className="progress" role="progressbar" aria-valuenow={Math.round(progress)} aria-valuemin={0} aria-valuemax={100}>
              <span style={{ width: `${progress}%`, background: RANK_TONES[data.rank] }} />
            </div>

            <ol className="ladder">
              {RANKS.map((r, i) => (
                <li key={r.name} className={i === data.rank ? "current" : i < data.rank ? "passed" : ""}>
                  <span className="ladder-dot" style={{ "--tone": RANK_TONES[i] }} />
                  <div>
                    <strong>{r.name}</strong>
                    <span>{r.min === 0 ? "Starting rank" : `${r.min}+ points`}</span>
                  </div>
                  <span className="ladder-perk">{i === 0 ? "Full stake" : `${r.discount} off stake`}</span>
                </li>
              ))}
            </ol>

            <p className="help-text" style={{ marginTop: 14 }}>
              Low +10 · Medium +25 · High +50 · Critical +100 · rejected report −15. Reputation is
              credited automatically by the escrow contract when a report is validated.
            </p>
          </section>

          <section className="card flush">
            <div className="card-head">
              <div>
                <h2>Leaderboard</h2>
                <p>Top researchers by on-chain reputation.</p>
              </div>
              <button type="button" className="btn btn-ghost sm" onClick={load}>
                <Icon name="refresh" size="sm" />
                Refresh
              </button>
            </div>
            {board.length === 0 ? (
              <Empty icon="award" title="No scores yet">
                Scores appear here as soon as the first report is validated.
              </Empty>
            ) : (
              <ol className="board">
                {board.map((row, i) => (
                  <li key={row.address} className={row.address.toLowerCase() === address.toLowerCase() ? "me" : ""}>
                    <span className="board-pos">{i + 1}</span>
                    <span className="mono">{shortAddr(row.address)}</span>
                    {row.address.toLowerCase() === address.toLowerCase() && <span className="you">you</span>}
                    <span style={{ marginLeft: "auto" }}>
                      <RankBadge rank={row.rank} />
                    </span>
                    <strong className="board-score">{row.score}</strong>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>

        <aside className="stack sticky">
          <section className="card">
            <div className="card-head">
              <div>
                <h2>Soulbound badge</h2>
                <p>Non-transferable. The artwork is generated by the contract and updates live.</p>
              </div>
            </div>

            {badge ? (
              <>
                <img className="badge-art" src={badge.image} alt={`${badge.name} — ${current.name}`} />
                <p className="help-text" style={{ textAlign: "center" }}>
                  {badge.name} · locked to <span className="mono">{shortAddr(address)}</span>
                </p>
              </>
            ) : (
              <>
                <div className="badge-placeholder">
                  <Icon name="award" size="lg" />
                  <span>No badge yet</span>
                </div>
                <button type="button" className="btn btn-primary block" onClick={claim} disabled={busy}>
                  {busy ? <Spinner /> : <Icon name="award" />}
                  Claim your badge
                </button>
                <p className="help-text">
                  Your score already counts without it — claiming just mints the badge so you can
                  show it off in any wallet.
                </p>
              </>
            )}
          </section>

          <section className="card">
            <div className="card-head">
              <div>
                <h2>Findings by severity</h2>
              </div>
            </div>
            <div className="sev-bars">
              {["Low", "Medium", "High", "Critical"].map((label, i) => {
                const max = Math.max(1, ...data.severities);
                return (
                  <div className="sev-bar" key={label}>
                    <span>{label}</span>
                    <div>
                      <i className={`sev-${label.toLowerCase()}`} style={{ width: `${(data.severities[i] / max) * 100}%` }} />
                    </div>
                    <strong>{data.severities[i]}</strong>
                  </div>
                );
              })}
            </div>
          </section>
        </aside>
      </div>
    </>
  );
}
