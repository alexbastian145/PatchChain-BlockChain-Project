// Fill these in after running `npx hardhat run scripts/deploy.js --network sepolia`
// in the project root — the deploy script prints each address ready to paste.
export const CONTRACT_ADDRESSES = {
  registry: import.meta.env.VITE_REGISTRY_ADDRESS || "",
  stakeManager: import.meta.env.VITE_STAKE_MANAGER_ADDRESS || "",
  escrow: import.meta.env.VITE_ESCROW_ADDRESS || "",
  disclosureTimer: import.meta.env.VITE_DISCLOSURE_TIMER_ADDRESS || "",
  keyRegistry: import.meta.env.VITE_KEY_REGISTRY_ADDRESS || "",
  reputation: import.meta.env.VITE_REPUTATION_ADDRESS || "",
  court: import.meta.env.VITE_COURT_ADDRESS || "",
};

export const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:4000";

// The stake a researcher actually pays is read from the chain (StakeManager.requiredStakeFor),
// because it shrinks with reputation. This is only the base amount used for display fallbacks.
export const BASE_STAKE_ETH = "0.01";

export const STATUS_LABELS = ["Submitted", "Under Review", "Validated", "Rejected", "Disclosed"];
export const SEVERITY_LABELS = ["Unset", "Low", "Medium", "High", "Critical"];

// ArbitrationCourt.phaseOf
export const PHASES = [
  "Awaiting jurors",
  "Evidence",
  "Commit votes",
  "Reveal votes",
  "Ready to finalize",
  "Decided",
  "Voided",
];

export const RANKS = [
  { name: "Rookie", min: 0, discount: "0%", stake: "100%" },
  { name: "Hunter", min: 50, discount: "25%", stake: "75%" },
  { name: "Elite", min: 150, discount: "50%", stake: "50%" },
  { name: "Legend", min: 400, discount: "75%", stake: "25%" },
];
