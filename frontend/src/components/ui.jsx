import { useState } from "react";

/* Lucide-style stroke icons, inlined so the frontend needs no extra dependency. */
const ICONS = {
  panel: (
    <>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
    </>
  ),
  shield: (
    <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
  ),
  filePlus: (
    <>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M12 18v-6" />
      <path d="M9 15h6" />
    </>
  ),
  clipboard: (
    <>
      <rect width="8" height="4" x="8" y="2" rx="1" ry="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <path d="M12 11h4" />
      <path d="M12 16h4" />
      <path d="M8 11h.01" />
      <path d="M8 16h.01" />
    </>
  ),
  building: (
    <>
      <path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z" />
      <path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" />
      <path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2" />
      <path d="M10 6h4" />
      <path d="M10 10h4" />
      <path d="M10 14h4" />
      <path d="M10 18h4" />
    </>
  ),
  wallet: (
    <>
      <path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1" />
      <path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4" />
    </>
  ),
  logout: (
    <>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5" />
      <path d="M21 12H9" />
    </>
  ),
  lock: (
    <>
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </>
  ),
  coins: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M18.09 10.37A6 6 0 1 1 10.34 18" />
      <path d="M7 6h1v4" />
      <path d="m16.71 13.88.7.71-2.82 2.82" />
    </>
  ),
  refresh: (
    <>
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </>
  ),
  alert: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </>
  ),
  check: (
    <>
      <path d="M21.801 10A10 10 0 1 1 17 3.335" />
      <path d="m9 11 3 3L22 4" />
    </>
  ),
  menu: (
    <>
      <path d="M4 6h16" />
      <path d="M4 12h16" />
      <path d="M4 18h16" />
    </>
  ),
  x: (
    <>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </>
  ),
  copy: (
    <>
      <rect width="14" height="14" x="8" y="8" rx="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </>
  ),
  inbox: (
    <>
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </>
  ),
  user: (
    <>
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </>
  ),
  eye: (
    <>
      <path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  ban: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="m4.9 4.9 14.2 14.2" />
    </>
  ),
};

export function Icon({ name, size, className = "" }) {
  return (
    <svg
      className={`icon ${size || ""} ${className}`}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      {ICONS[name]}
    </svg>
  );
}

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

export function BrandMark({ large = false }) {
  return (
    <div className={`brand ${large ? "large" : ""}`}>
      <span className="brand-mark">
        <Icon name="shield" size={large ? "lg" : ""} />
      </span>
      <span className="brand-name">PatchChain</span>
    </div>
  );
}

/* Ported from the panel's auth screen: slow drifting violet strands. */
const PATH_COUNT = 36;

function PathLayer({ position }) {
  const paths = Array.from({ length: PATH_COUNT }, (_, i) => ({
    id: i,
    d: `M-${420 - i * 5 * position} -${220 + i * 6}C-${420 - i * 5 * position} -${220 + i * 6} -${
      300 - i * 5 * position
    } ${220 - i * 6} ${130 - i * 5 * position} ${360 - i * 6}C${700 - i * 5 * position} ${
      500 - i * 6
    } ${760 - i * 5 * position} ${900 - i * 6} ${760 - i * 5 * position} ${900 - i * 6}`,
    width: 0.55 + i * 0.04,
    opacity: (0.05 + i * 0.015).toFixed(3),
    duration: 22 + (i % 6) * 2,
    delay: -(i * 0.75),
  }));

  return (
    <div className="paths">
      <svg fill="none" viewBox="0 0 820 420" aria-hidden="true">
        {paths.map((p) => (
          <path
            key={p.id}
            d={p.d}
            pathLength={1}
            stroke="currentColor"
            strokeDasharray="1 1"
            strokeOpacity={p.opacity}
            strokeWidth={p.width}
            style={{
              "--duration": `${p.duration}s`,
              "--stroke-opacity": p.opacity,
              animationDelay: `${p.delay}s`,
            }}
          />
        ))}
      </svg>
    </div>
  );
}

export function FloatingPaths() {
  return (
    <>
      <PathLayer position={1} />
      <PathLayer position={-1} />
    </>
  );
}

/* ---- status + severity ---- */

export const STATUS_META = {
  Submitted: { label: "Submitted", tone: "tone-submitted" },
  UnderReview: { label: "Under Review", tone: "tone-review" },
  Validated: { label: "Validated", tone: "tone-validated" },
  Rejected: { label: "Rejected", tone: "tone-rejected" },
  Disclosed: { label: "Disclosed", tone: "tone-disclosed" },
};

export function StatusBadge({ status }) {
  const meta = STATUS_META[status] || { label: status, tone: "tone-submitted" };
  return <span className={`badge ${meta.tone}`}>{meta.label}</span>;
}

export function Alert({ tone = "info", busy = false, children, onDismiss }) {
  const icon = tone === "success" ? "check" : tone === "error" || tone === "warn" ? "alert" : null;
  return (
    <div className={`alert ${tone}`} role={tone === "error" ? "alert" : "status"}>
      {busy ? <Spinner /> : icon && <Icon name={icon} size="sm" />}
      <div style={{ flex: 1 }}>{children}</div>
      {onDismiss && (
        <button
          type="button"
          className="icon-btn"
          style={{ width: 22, height: 22, color: "inherit" }}
          onClick={onDismiss}
          aria-label="Dismiss"
        >
          <Icon name="x" size="sm" />
        </button>
      )}
    </div>
  );
}

export function Stat({ icon, value, label, tone }) {
  return (
    <div className="stat" style={tone ? { "--tone": tone } : undefined}>
      <span className="stat-icon">
        <Icon name={icon} />
      </span>
      <div>
        <div className="stat-value">{value}</div>
        <div className="stat-label">{label}</div>
      </div>
    </div>
  );
}

export function Empty({ icon = "inbox", title, children, action }) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon name={icon} size="lg" />
      </span>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}

export function SkeletonRows({ count = 3 }) {
  return (
    <div aria-busy="true" aria-label="Loading">
      {Array.from({ length: count }, (_, i) => (
        <div className="skeleton-row" key={i}>
          <div className="skeleton" style={{ width: 40, height: 40, borderRadius: 11 }} />
          <div style={{ flex: 1, display: "grid", gap: 8 }}>
            <div className="skeleton" style={{ width: "32%", height: 14 }} />
            <div className="skeleton" style={{ width: "52%", height: 11 }} />
          </div>
          <div className="skeleton" style={{ width: 84, height: 26, borderRadius: 999 }} />
        </div>
      ))}
    </div>
  );
}

export function CopyButton({ text, label = "Copy" }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable — fail quietly */
    }
  }

  return (
    <button type="button" className="btn btn-ghost sm" onClick={copy}>
      <Icon name={copied ? "check" : "copy"} size="sm" />
      {copied ? "Copied" : label}
    </button>
  );
}

export function shortAddr(addr) {
  if (!addr) return "";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function formatDate(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export const CHAIN_NAMES = {
  1: "Ethereum",
  11155111: "Sepolia",
  17000: "Holesky",
  31337: "Hardhat",
  1337: "Localhost",
};
