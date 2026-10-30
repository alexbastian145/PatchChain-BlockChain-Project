import { useEffect, useState } from "react";
import { useWallet } from "./utils/useWallet";
import SubmitReport from "./components/SubmitReport.jsx";
import MyReports from "./components/MyReports.jsx";
import OrgDashboard from "./components/OrgDashboard.jsx";
import Reputation from "./components/Reputation.jsx";
import Arbitration from "./components/Arbitration.jsx";
import { useCrypto } from "./utils/useCrypto";
import {
  Alert,
  BrandMark,
  CHAIN_NAMES,
  FloatingPaths,
  Icon,
  shortAddr,
} from "./components/ui.jsx";

const NAV = [
  {
    group: "Researcher",
    items: [
      {
        id: "submit",
        label: "Submit Report",
        icon: "filePlus",
        title: "Submit a report",
        sub: "Encrypted, staked and anchored on-chain",
      },
      {
        id: "my-reports",
        label: "My Reports",
        icon: "clipboard",
        title: "My reports",
        sub: "Track, read and disclose every report you've filed",
      },
      {
        id: "reputation",
        label: "Reputation",
        icon: "award",
        title: "Reputation",
        sub: "A soulbound badge that lowers your stake as you earn trust",
      },
    ],
  },
  {
    group: "Organization",
    items: [
      {
        id: "org",
        label: "Organization Dashboard",
        icon: "building",
        title: "Organization dashboard",
        sub: "Review incoming reports, fund the escrow and pay out bounties",
      },
    ],
  },
  {
    group: "Justice",
    items: [
      {
        id: "arbitration",
        label: "Arbitration",
        icon: "scale",
        title: "Arbitration court",
        sub: "Disputes decided by a staked jury with sealed, commit-reveal votes",
      },
    ],
  },
];

const ALL_ITEMS = NAV.flatMap((g) => g.items);

function readCollapsed() {
  try {
    return localStorage.getItem("patchchain:sidebar") === "collapsed";
  } catch {
    return false;
  }
}

export default function App() {
  const { address, signer, chainId, error, connect, disconnect, switchAccount } = useWallet();
  const [tab, setTab] = useState("submit");
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [drawer, setDrawer] = useState(false);
  const crypto = useCrypto(signer, address);

  useEffect(() => {
    try {
      localStorage.setItem("patchchain:sidebar", collapsed ? "collapsed" : "open");
    } catch {
      /* storage unavailable */
    }
  }, [collapsed]);

  if (!address) {
    return <ConnectGate onConnect={connect} error={error} />;
  }

  const current = ALL_ITEMS.find((i) => i.id === tab);
  const network = chainId ? CHAIN_NAMES[chainId] || `Chain ${chainId}` : null;

  function go(id) {
    setTab(id);
    setDrawer(false);
  }

  return (
    <div className={`shell ${collapsed ? "collapsed" : ""} ${drawer ? "drawer-open" : ""}`}>
      <aside className="sidebar" aria-label="Primary">
        <div className="sidebar-head">
          {collapsed ? (
            <>
              <button
                type="button"
                className="icon-btn collapse-btn"
                onClick={() => setCollapsed(false)}
                aria-label="Expand sidebar"
              >
                <Icon name="panel" />
              </button>
              <div className="brand">
                <BrandMark />
              </div>
            </>
          ) : (
            <>
              <BrandMark />
              <button
                type="button"
                className="icon-btn collapse-btn"
                onClick={() => setCollapsed(true)}
                aria-label="Collapse sidebar"
              >
                <Icon name="panel" />
              </button>
            </>
          )}
          <button
            type="button"
            className="icon-btn menu-btn-close"
            onClick={() => setDrawer(false)}
            aria-label="Close menu"
            style={{ display: drawer ? "grid" : "none" }}
          >
            <Icon name="x" />
          </button>
        </div>

        <nav className="nav">
          {NAV.map((group) => (
            <div key={group.group} style={{ display: "contents" }}>
              <div className="nav-label">{group.group}</div>
              {group.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`nav-item ${tab === item.id ? "active" : ""}`}
                  onClick={() => go(item.id)}
                  aria-current={tab === item.id ? "page" : undefined}
                  title={collapsed ? item.label : undefined}
                >
                  <Icon name={item.icon} />
                  <span className="label-text">{item.label}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar-foot">
          <div className="account">
            <span className="avatar" aria-hidden="true">
              {address.slice(2, 4).toUpperCase()}
            </span>
            <div className="account-meta">
              <strong className="mono" title={address}>{shortAddr(address)}</strong>
              <span>{network || "Connected"}</span>
            </div>
            <button
              type="button"
              className="icon-btn"
              onClick={switchAccount}
              aria-label="Switch account"
              title="Switch account"
            >
              <Icon name="refresh" />
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={disconnect}
              aria-label="Disconnect wallet"
              title="Disconnect"
            >
              <Icon name="logout" />
            </button>
          </div>
        </div>
      </aside>

      <div className="scrim" onClick={() => setDrawer(false)} />

      <div className="main">
        <header className="topbar">
          <button
            type="button"
            className="icon-btn menu-btn"
            onClick={() => setDrawer(true)}
            aria-label="Open menu"
          >
            <Icon name="menu" />
          </button>
          <div className="topbar-title">
            <h1>{current.title}</h1>
            <p>{current.sub}</p>
          </div>
          {network && (
            <span className="pill hide-sm">
              <span className="dot" />
              {network}
            </span>
          )}
        </header>

        <main className="page">
          {error && <Alert tone="error">{error}</Alert>}

          {tab === "submit" && <SubmitReport signer={signer} address={address} crypto={crypto} />}
          {tab === "my-reports" && (
            <MyReports
              address={address}
              signer={signer}
              crypto={crypto}
              onSubmitNew={() => go("submit")}
              onGoArbitration={() => go("arbitration")}
            />
          )}
          {tab === "reputation" && <Reputation signer={signer} address={address} />}
          {tab === "org" && <OrgDashboard signer={signer} address={address} crypto={crypto} />}
          {tab === "arbitration" && <Arbitration signer={signer} address={address} crypto={crypto} />}
        </main>
      </div>
    </div>
  );
}

function ConnectGate({ onConnect, error }) {
  return (
    <main className="gate">
      <section className="gate-hero">
        <BrandMark large />
        <FloatingPaths />
        <div className="gate-copy">
          <h2>
            Disclose vulnerabilities. <span>Get paid on-chain.</span>
          </h2>
          <p>
            Researchers stake, organizations validate, and the escrow pays out automatically — no
            middlemen, no disputes over who reported first.
          </p>
          <ul className="gate-points">
            <li>
              <Icon name="lock" /> Reports are end-to-end encrypted in your browser
            </li>
            <li>
              <Icon name="clock" /> Hash and timestamp anchored on-chain as proof of discovery
            </li>
            <li>
              <Icon name="scale" /> Disputes decided by a staked jury, not a single party
            </li>
          </ul>
        </div>
      </section>

      <section className="gate-panel">
        <div className="gate-form">
          <div className="gate-mobile-brand">
            <BrandMark large />
          </div>
          <div>
            <h1>Connect your wallet</h1>
            <p className="lead">
              PatchChain uses MetaMask to sign submissions, fund bounties and approve payouts
              directly on-chain.
            </p>
          </div>

          {error && <Alert tone="error">{error}</Alert>}

          <button type="button" className="btn btn-primary block" onClick={onConnect}>
            <Icon name="wallet" />
            Connect MetaMask
          </button>

          <p className="gate-foot">Your keys never leave your wallet.</p>
        </div>
      </section>
    </main>
  );
}
