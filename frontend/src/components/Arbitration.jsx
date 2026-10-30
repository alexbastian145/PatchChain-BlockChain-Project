import { useCallback, useEffect, useRef, useState } from "react";
import { hexlify, parseEther, randomBytes } from "ethers";
import { PHASES, SEVERITY_LABELS } from "../config";
import { getContracts, errorMessage } from "../utils/contracts";
import { addRecipients, decryptReport } from "../utils/e2ee";
import { fetchEnvelope, pinEnvelope } from "../utils/api";
import EncryptionKeyCard from "./EncryptionKeyCard.jsx";
import {
  Alert,
  Empty,
  Icon,
  Modal,
  ReportView,
  Spinner,
  Stat,
  formatEth,
  shortAddr,
} from "./ui.jsx";

const PHASE = { Open: 0, Evidence: 1, Commit: 2, Reveal: 3, Awaiting: 4, Decided: 5, Voided: 6 };
const RULINGS = [
  { value: 0, label: "Reject report" },
  { value: 1, label: "Pay · Low" },
  { value: 2, label: "Pay · Medium" },
  { value: 3, label: "Pay · High" },
  { value: 4, label: "Pay · Critical" },
];
const PHASE_TONE = [
  "var(--info)",
  "var(--violet-400)",
  "var(--warning)",
  "var(--warning)",
  "var(--info)",
  "var(--success)",
  "var(--faint)",
];

const same = (a, b) => a && b && a.toLowerCase() === b.toLowerCase();

// The salt for a sealed vote must survive a page refresh, or the juror can never reveal.
const voteKey = (court, caseId, address) => `patchchain:vote:${court}:${caseId}:${address.toLowerCase()}`;
function saveVote(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable — the in-memory copy below still covers this session */
  }
}
function loadVote(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function countdown(targetSeconds) {
  const left = targetSeconds - Math.floor(Date.now() / 1000);
  if (left <= 0) return "ended";
  if (left >= 3600) return `${Math.floor(left / 3600)}h ${Math.floor((left % 3600) / 60)}m left`;
  if (left >= 60) return `${Math.floor(left / 60)}m ${left % 60}s left`;
  return `${left}s left`;
}

export default function Arbitration({ signer, address, crypto }) {
  const [info, setInfo] = useState(null);
  const [cases, setCases] = useState([]);
  const [disputed, setDisputed] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(null);
  const [busyKey, setBusyKey] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [hasKey, setHasKey] = useState(false);
  const [stakeInput, setStakeInput] = useState("");
  const [rulings, setRulings] = useState({}); // caseId -> selected ruling
  const memoryVotes = useRef({});

  const load = useCallback(async () => {
    try {
      const { court, registry, escrow, keyRegistry } = getContracts(signer);
      const [
        panelSize,
        jurorDeposit,
        caseLock,
        fee,
        evidencePeriod,
        commitPeriod,
        revealPeriod,
        poolSize,
        isJuror,
        balance,
        locked,
        refund,
        registered,
        caseCount,
        reportCount,
      ] = await Promise.all([
        court.panelSize(),
        court.jurorDeposit(),
        court.caseLock(),
        court.arbitrationFee(),
        court.evidencePeriod(),
        court.commitPeriod(),
        court.revealPeriod(),
        court.jurorCount(),
        court.isJuror(address),
        court.balanceOf(address),
        court.lockedOf(address),
        court.refundOf(address),
        keyRegistry.hasKey(address),
        court.caseCount(),
        registry.reportCount(),
      ]);

      setInfo({
        panelSize: Number(panelSize),
        jurorDeposit,
        caseLock,
        fee,
        evidencePeriod: Number(evidencePeriod),
        commitPeriod: Number(commitPeriod),
        revealPeriod: Number(revealPeriod),
        poolSize: Number(poolSize),
        isJuror,
        balance,
        locked,
        refund,
      });
      setHasKey(registered);

      // Cases (demo scale: read them all).
      const loaded = await Promise.all(
        Array.from({ length: Number(caseCount) }, async (_, id) => {
          const [c, phase, evidence, revealed] = await Promise.all([
            court.getCase(id),
            court.phaseOf(id),
            court.getEvidence(id),
            court.revealedCount(id),
          ]);
          const jurors = [...c.jurors];
          const rep = await registry.getReport(c.reportId);
          const votes = await Promise.all(jurors.map((j) => court.getVote(id, j)));
          return {
            id,
            reportId: Number(c.reportId),
            opener: c.opener,
            status: Number(c.status),
            phase: Number(phase),
            evidenceEnd: Number(c.evidenceEnd),
            commitEnd: Number(c.commitEnd),
            revealEnd: Number(c.revealEnd),
            payResearcher: c.payResearcher,
            severity: Number(c.severity),
            executed: c.executed,
            jurors,
            votes: votes.map((v) => ({ committed: v.committed, revealed: v.revealed, ruling: Number(v.ruling) })),
            evidence: evidence.map((e) => ({ party: e.party, cid: e.cid })),
            revealedCount: Number(revealed),
            researcher: rep.researcher,
            organization: rep.organization,
            reportCID: rep.ipfsCID,
            reportHash: rep.reportHash,
          };
        })
      );
      setCases(loaded);

      // Disputed reports I'm a party to and that have no live case.
      const mine = [];
      for (let i = 0; i < Number(reportCount); i++) {
        const rep = await registry.getReport(i);
        if (!same(rep.researcher, address) && !same(rep.organization, address)) continue;
        if (Number(await escrow.payoutState(i)) !== 2) continue;
        const active = Number(await court.activeCaseOf(i));
        if (active !== 0 && loaded[active - 1] && loaded[active - 1].status !== 3) continue;
        mine.push({ reportId: i, role: same(rep.researcher, address) ? "Researcher" : "Organization" });
      }
      setDisputed(mine);
      setError("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [signer, address]);

  useEffect(() => {
    load();
    const t = setInterval(() => {
      if (!document.hidden) load();
    }, 20000);
    return () => clearInterval(t);
  }, [load]);

  async function run(key, pending, action, success) {
    setBusyKey(key);
    setNotice({ tone: "info", text: pending });
    try {
      const result = await action();
      setNotice({ tone: "success", text: typeof success === "function" ? success(result) : success });
      await load();
    } catch (err) {
      setNotice({ tone: "error", text: errorMessage(err) });
    } finally {
      setBusyKey(null);
    }
  }

  const contracts = () => getContracts(signer);
  const anyBusy = Boolean(busyKey);

  // ---------- juror pool ----------
  const join = () =>
    run("join", "Joining the jury…", async () => {
      await (await contracts().court.joinJury({ value: info.jurorDeposit })).wait();
    }, "You're on the jury. You may now be drawn for cases.");

  const addStake = () =>
    run("stake", "Adding stake…", async () => {
      await (await contracts().court.addStake({ value: parseEther(stakeInput) })).wait();
      setStakeInput("");
    }, "Stake added.");

  const withdrawFree = () =>
    run("withdraw", "Withdrawing…", async () => {
      await (await contracts().court.withdraw(info.balance - info.locked)).wait();
    }, "Withdrawn.");

  const leave = () =>
    run("leave", "Leaving the jury…", async () => {
      await (await contracts().court.leaveJury()).wait();
    }, "You left the jury and your balance was returned.");

  const claimRefund = () =>
    run("refund", "Claiming…", async () => {
      await (await contracts().court.claimRefund()).wait();
    }, "Refund claimed.");

  // ---------- cases ----------
  const openCase = (reportId) =>
    run(`open-${reportId}`, "Opening the case and paying the fee…", async () => {
      await (await contracts().court.openCase(reportId, { value: info.fee })).wait();
    }, "Case opened. Anyone can now draw the jury.");

  const drawJurors = (id) =>
    run(`draw-${id}`, "Drawing jurors…", async () => {
      await (await contracts().court.drawJurors(id)).wait();
    }, "Jury drawn. The evidence period has started.");

  const shareReport = (c) =>
    run(`share-${c.id}`, "Re-encrypting the report for the jury…", async () => {
      const keys = await crypto.ensureKeys();
      const { keyRegistry, court } = contracts();
      const bytes = await fetchEnvelope(c.reportCID, c.reportHash);
      const pubkeys = await Promise.all(c.jurors.map((j) => keyRegistry.publicKeyOf(j)));
      const recipients = Object.fromEntries(c.jurors.map((j, i) => [j, pubkeys[i]]));
      const { envelopeBytes } = addRecipients(bytes, address, keys.secretKey, recipients);
      const pinned = await pinEnvelope(envelopeBytes);
      await (await court.submitEvidence(c.id, pinned.cid)).wait();
    }, "Report shared with the jury. Only these jurors can read it.");

  const readEvidence = (c, item) =>
    run(`read-${c.id}-${item.cid}`, "Decrypting evidence…", async () => {
      const keys = await crypto.ensureKeys();
      const bytes = await fetchEnvelope(item.cid);
      setViewing({ id: c.reportId, content: decryptReport(bytes, address, keys.secretKey) });
    }, "Evidence decrypted in your browser.");

  const commit = (c) =>
    run(`commit-${c.id}`, "Sealing your vote…", async () => {
      const ruling = rulings[c.id] ?? 0;
      const salt = hexlify(randomBytes(32));
      const { court } = contracts();
      const hash = await court.hashVote(c.id, address, ruling, salt);
      const key = voteKey(await court.getAddress(), c.id, address);
      memoryVotes.current[key] = { ruling, salt };
      saveVote(key, { ruling, salt });
      await (await court.commitVote(c.id, hash)).wait();
    }, "Vote sealed. Nobody — including the other jurors — can see it until the reveal phase.");

  const reveal = (c) =>
    run(`reveal-${c.id}`, "Revealing your vote…", async () => {
      const { court } = contracts();
      const key = voteKey(await court.getAddress(), c.id, address);
      const saved = memoryVotes.current[key] || loadVote(key);
      if (!saved) throw new Error("Your sealed vote was not found in this browser, so it can't be revealed.");
      await (await court.revealVote(c.id, saved.ruling, saved.salt)).wait();
    }, "Vote revealed.");

  const finalize = (c) =>
    run(`final-${c.id}`, "Tallying votes and settling…", async () => {
      await (await contracts().court.finalize(c.id)).wait();
    }, "Case finalized.");

  const retry = (c) =>
    run(`retry-${c.id}`, "Retrying execution…", async () => {
      await (await contracts().court.retryExecute(c.id)).wait();
    }, "Ruling executed.");

  if (loading) {
    return (
      <div className="card">
        <p className="help-text">Reading the court from the chain…</p>
      </div>
    );
  }
  if (!info) return error ? <Alert tone="error">{error}</Alert> : null;

  const free = info.balance - info.locked;
  const myCases = cases.filter((c) => c.jurors.some((j) => same(j, address)));

  return (
    <>
      <div className="stats">
        <Stat icon="users" value={info.poolSize} label="Jurors in the pool" />
        <Stat icon="scale" value={cases.length} label="Cases heard" tone="var(--violet-300)" />
        <Stat icon="coins" value={`${formatEth(info.fee)} ETH`} label="Arbitration fee" tone="var(--info)" />
        <Stat icon="award" value={`${formatEth(info.caseLock)} ETH`} label="Stake at risk per case" tone="var(--warning)" />
      </div>

      {notice && (
        <Alert tone={notice.tone} busy={anyBusy && notice.tone === "info"} onDismiss={anyBusy ? undefined : () => setNotice(null)}>
          {notice.text}
        </Alert>
      )}
      {error && <Alert tone="error">{error}</Alert>}

      <div className="split">
        <div className="stack">
          <section className="card flush">
            <div className="card-head">
              <div>
                <h2>Cases</h2>
                <p>
                  {myCases.length > 0
                    ? `You're on the panel for ${myCases.length} case${myCases.length === 1 ? "" : "s"}.`
                    : "Disputes are decided by a panel of staked jurors, not a single trusted party."}
                </p>
              </div>
              <button type="button" className="btn btn-ghost sm" onClick={load} disabled={anyBusy}>
                <Icon name="refresh" size="sm" />
                Refresh
              </button>
            </div>

            {cases.length === 0 ? (
              <Empty icon="scale" title="No cases yet">
                When a researcher and organization disagree, either side can open a case here and a
                random jury decides it.
              </Empty>
            ) : (
              <div className="report-list">
                {[...cases].reverse().map((c) => (
                  <CaseCard
                    key={c.id}
                    c={c}
                    address={address}
                    info={info}
                    busyKey={busyKey}
                    ruling={rulings[c.id] ?? 0}
                    onRuling={(v) => setRulings((r) => ({ ...r, [c.id]: v }))}
                    onDraw={drawJurors}
                    onShare={shareReport}
                    onRead={readEvidence}
                    onCommit={commit}
                    onReveal={reveal}
                    onFinalize={finalize}
                    onRetry={retry}
                  />
                ))}
              </div>
            )}
          </section>
        </div>

        <aside className="stack">
          <section className="card">
            <div className="card-head">
              <div>
                <h2>Open a case</h2>
                <p>Escalate a disputed report to the jury. The fee is refunded if the case can't be decided.</p>
              </div>
              <span className="stat-icon">
                <Icon name="scale" />
              </span>
            </div>
            {disputed.length === 0 ? (
              <p className="help-text">
                No disputed reports waiting. Raise a dispute from <strong>My Reports</strong> or the{" "}
                <strong>Organization Dashboard</strong> first.
              </p>
            ) : (
              <div className="mini-list">
                {disputed.map((d) => (
                  <div className="mini-row" key={d.reportId}>
                    <div>
                      <strong>Report #{d.reportId}</strong>
                      <span>You are the {d.role.toLowerCase()}</span>
                    </div>
                    <button type="button" className="btn btn-primary sm" onClick={() => openCase(d.reportId)} disabled={anyBusy || info.poolSize < info.panelSize + 2}>
                      {busyKey === `open-${d.reportId}` ? <Spinner /> : <Icon name="send" size="sm" />}
                      Open · {formatEth(info.fee)} ETH
                    </button>
                  </div>
                ))}
              </div>
            )}
            {info.poolSize < info.panelSize + 2 && (
              <p className="help-text">
                The court needs at least {info.panelSize + 2} jurors before it can hear cases
                ({info.poolSize} so far).
              </p>
            )}
          </section>

          <section className="card">
            <div className="card-head">
              <div>
                <h2>Jury duty</h2>
                <p>Stake ETH, vote honestly, earn fees. Wrong or missing votes are slashed.</p>
              </div>
              <span className="stat-icon">
                <Icon name="users" />
              </span>
            </div>

            {!info.isJuror ? (
              !hasKey ? (
                <>
                  <Alert tone="warn">
                    Jurors need an encryption key so parties can share evidence with them privately.
                  </Alert>
                  <div style={{ marginTop: 14 }}>
                    <EncryptionKeyCard
                      signer={signer}
                      address={address}
                      crypto={crypto}
                      title="Create your juror key"
                      blurb="Published on-chain so evidence can be encrypted to you."
                      onChange={({ registered }) => setHasKey(registered)}
                    />
                  </div>
                </>
              ) : (
                <>
                  <p className="help-text" style={{ marginTop: 0 }}>
                    Deposit <strong>{formatEth(info.jurorDeposit)} ETH</strong>. Each case locks{" "}
                    {formatEth(info.caseLock)} ETH of it; you lose that if you vote against the
                    majority or don't reveal, and share it (plus the fee) if you vote with it.
                  </p>
                  <button type="button" className="btn btn-primary block" style={{ marginTop: 14 }} onClick={join} disabled={anyBusy}>
                    {busyKey === "join" ? <Spinner /> : <Icon name="users" />}
                    Join the jury
                  </button>
                </>
              )
            ) : (
              <>
                <div className="kv">
                  <span>Balance</span>
                  <strong>{formatEth(info.balance)} ETH</strong>
                  <span>Locked in cases</span>
                  <strong>{formatEth(info.locked)} ETH</strong>
                  <span>Free to withdraw</span>
                  <strong>{formatEth(free)} ETH</strong>
                </div>
                {free < info.caseLock && (
                  <div style={{ marginTop: 12 }}>
                    <Alert tone="warn">
                      Your free balance is below {formatEth(info.caseLock)} ETH, so you won't be drawn for
                      new cases. Add stake to become eligible again.
                    </Alert>
                  </div>
                )}
                <div className="field" style={{ marginTop: 14 }}>
                  <label htmlFor="addstake">Add stake</label>
                  <div className="input-group">
                    <input id="addstake" className="input mono" inputMode="decimal" placeholder="0.05" value={stakeInput} onChange={(e) => setStakeInput(e.target.value)} />
                    <span className="suffix">ETH</span>
                  </div>
                </div>
                <div className="row" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
                  <button type="button" className="btn btn-ghost sm" onClick={addStake} disabled={anyBusy || !stakeInput || Number(stakeInput) <= 0}>
                    {busyKey === "stake" ? <Spinner /> : <Icon name="plus" size="sm" />}
                    Add
                  </button>
                  <button type="button" className="btn btn-ghost sm" onClick={withdrawFree} disabled={anyBusy || free === 0n}>
                    {busyKey === "withdraw" ? <Spinner /> : <Icon name="coins" size="sm" />}
                    Withdraw free
                  </button>
                  <button type="button" className="btn btn-danger sm" onClick={leave} disabled={anyBusy || info.locked > 0n}>
                    {busyKey === "leave" ? <Spinner /> : <Icon name="logout" size="sm" />}
                    Leave jury
                  </button>
                </div>
                {info.locked > 0n && <p className="help-text">You can leave once your open cases are settled.</p>}
              </>
            )}

            {info.refund > 0n && (
              <button type="button" className="btn btn-success block" style={{ marginTop: 16 }} onClick={claimRefund} disabled={anyBusy}>
                {busyKey === "refund" ? <Spinner /> : <Icon name="coins" />}
                Claim {formatEth(info.refund)} ETH owed to you
              </button>
            )}
          </section>
        </aside>
      </div>

      {viewing && (
        <Modal title={`Report #${viewing.id}`} subtitle="Decrypted locally with your juror key." onClose={() => setViewing(null)}>
          <ReportView report={viewing.content} />
        </Modal>
      )}
    </>
  );
}

function CaseCard({ c, address, info, busyKey, ruling, onRuling, onDraw, onShare, onRead, onCommit, onReveal, onFinalize, onRetry }) {
  const anyBusy = Boolean(busyKey);
  const myIndex = c.jurors.findIndex((j) => same(j, address));
  const isJuror = myIndex >= 0;
  const isParty = same(c.researcher, address) || same(c.organization, address);
  const myVote = isJuror ? c.votes[myIndex] : null;
  const allRevealed = c.jurors.length > 0 && c.revealedCount === c.jurors.length;
  const mySharedAlready = c.evidence.some((e) => same(e.party, address));

  const timer =
    c.phase === PHASE.Evidence
      ? `Evidence ${countdown(c.evidenceEnd)}`
      : c.phase === PHASE.Commit
        ? `Commit ${countdown(c.commitEnd)}`
        : c.phase === PHASE.Reveal
          ? `Reveal ${countdown(c.revealEnd)}`
          : "";

  return (
    <article className="report case">
      <div className="report-top">
        <span className="report-icon">
          <Icon name="scale" />
        </span>
        <div className="report-main">
          <h3>
            Case <span className="mono">#{c.id}</span> · Report <span className="mono">#{c.reportId}</span>
          </h3>
          <div className="meta">
            <span>
              <Icon name="user" size="sm" />
              <span className="mono">{shortAddr(c.researcher)}</span>
              <span className="faint">vs</span>
              <span className="mono">{shortAddr(c.organization)}</span>
            </span>
            {timer && (
              <span>
                <Icon name="clock" size="sm" />
                {timer}
              </span>
            )}
          </div>
        </div>
        <span className="badge" style={{ "--tone": PHASE_TONE[c.phase] }}>
          {PHASES[c.phase]}
        </span>
      </div>

      {c.jurors.length > 0 && (
        <div className="panel">
          {c.jurors.map((j, i) => (
            <span key={j} className={`juror ${same(j, address) ? "me" : ""}`}>
              <span className="mono">{shortAddr(j)}</span>
              {c.phase >= PHASE.Reveal || c.phase === PHASE.Decided ? (
                c.votes[i].revealed ? (
                  <em>{RULINGS[c.votes[i].ruling].label}</em>
                ) : (
                  <em className="faint">{c.votes[i].committed ? "didn't reveal" : "didn't vote"}</em>
                )
              ) : c.votes[i].committed ? (
                <em className="ok">sealed</em>
              ) : null}
            </span>
          ))}
        </div>
      )}

      {c.evidence.length > 0 && (
        <div className="evidence">
          <span className="label">Evidence</span>
          {c.evidence.map((e) => (
            <div className="mini-row" key={e.cid}>
              <div>
                <strong>Shared by {same(e.party, c.researcher) ? "the researcher" : "the organization"}</strong>
                <span className="mono">{e.cid.slice(0, 18)}…</span>
              </div>
              {isJuror && (
                <button type="button" className="btn btn-ghost sm" onClick={() => onRead(c, e)} disabled={anyBusy}>
                  {busyKey === `read-${c.id}-${e.cid}` ? <Spinner /> : <Icon name="unlock" size="sm" />}
                  Read
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="row-actions">
        {c.phase === PHASE.Open && (
          <button type="button" className="btn btn-primary sm" onClick={() => onDraw(c.id)} disabled={anyBusy}>
            {busyKey === `draw-${c.id}` ? <Spinner /> : <Icon name="users" size="sm" />}
            Draw jurors
          </button>
        )}

        {c.phase === PHASE.Evidence && isParty && (
          <button type="button" className="btn btn-primary sm" onClick={() => onShare(c)} disabled={anyBusy || mySharedAlready}>
            {busyKey === `share-${c.id}` ? <Spinner /> : <Icon name="send" size="sm" />}
            {mySharedAlready ? "Report shared" : "Share report with the jury"}
          </button>
        )}

        {c.phase === PHASE.Commit && isJuror && !myVote.committed && (
          <div className="vote-form">
            <select className="input" value={ruling} onChange={(e) => onRuling(Number(e.target.value))} aria-label="Your ruling">
              {RULINGS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
            <button type="button" className="btn btn-primary sm" onClick={() => onCommit(c)} disabled={anyBusy}>
              {busyKey === `commit-${c.id}` ? <Spinner /> : <Icon name="lock" size="sm" />}
              Seal vote
            </button>
          </div>
        )}
        {c.phase === PHASE.Commit && isJuror && myVote.committed && (
          <span className="help ok">
            <Icon name="check" size="sm" /> Your vote is sealed — reveal it in the next phase.
          </span>
        )}

        {c.phase === PHASE.Reveal && isJuror && myVote.committed && !myVote.revealed && (
          <button type="button" className="btn btn-primary sm" onClick={() => onReveal(c)} disabled={anyBusy}>
            {busyKey === `reveal-${c.id}` ? <Spinner /> : <Icon name="eye" size="sm" />}
            Reveal my vote
          </button>
        )}
        {c.phase === PHASE.Reveal && isJuror && !myVote.committed && (
          <span className="help warn">
            <Icon name="alert" size="sm" /> You didn't commit a vote, so you'll be slashed.
          </span>
        )}

        {(c.phase === PHASE.Awaiting || (c.phase === PHASE.Reveal && allRevealed)) && (
          <button type="button" className="btn btn-success sm" onClick={() => onFinalize(c)} disabled={anyBusy}>
            {busyKey === `final-${c.id}` ? <Spinner /> : <Icon name="check" size="sm" />}
            Finalize case
          </button>
        )}

        {c.phase === PHASE.Decided && (
          <>
            <span className="help ok">
              <Icon name="scale" size="sm" />
              {c.payResearcher
                ? `Ruled for the researcher — paid at ${SEVERITY_LABELS[c.severity]} severity.`
                : "Ruled against the researcher — report rejected."}
            </span>
            {!c.executed && (
              <button type="button" className="btn btn-primary sm" onClick={() => onRetry(c)} disabled={anyBusy}>
                {busyKey === `retry-${c.id}` ? <Spinner /> : <Icon name="refresh" size="sm" />}
                Retry execution
              </button>
            )}
          </>
        )}
        {c.phase === PHASE.Decided && !c.executed && (
          <span className="help warn">
            <Icon name="alert" size="sm" /> Not executed yet — the organization may need to fund its escrow or set the
            bounty tier.
          </span>
        )}

        {c.phase === PHASE.Voided && (
          <span className="help warn">
            <Icon name="alert" size="sm" /> No majority. The fee was refunded; either party can open a new case.
          </span>
        )}
      </div>
    </article>
  );
}
