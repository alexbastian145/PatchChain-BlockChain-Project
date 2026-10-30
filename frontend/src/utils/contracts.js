import { Contract } from "ethers";
import { CONTRACT_ADDRESSES } from "../config";

import registryAbi from "../abis/VulnerabilityRegistry.json";
import stakeManagerAbi from "../abis/StakeManager.json";
import escrowAbi from "../abis/BountyEscrow.json";
import timerAbi from "../abis/DisclosureTimer.json";
import keyRegistryAbi from "../abis/KeyRegistry.json";
import reputationAbi from "../abis/ReputationNFT.json";
import courtAbi from "../abis/ArbitrationCourt.json";

/**
 * Builds ethers Contract instances bound to the connected wallet's signer.
 * Call this fresh whenever the signer changes (new account/network).
 */
export function getContracts(signer) {
  if (!signer) return null;

  return {
    registry: new Contract(CONTRACT_ADDRESSES.registry, registryAbi.abi, signer),
    stakeManager: new Contract(CONTRACT_ADDRESSES.stakeManager, stakeManagerAbi.abi, signer),
    escrow: new Contract(CONTRACT_ADDRESSES.escrow, escrowAbi.abi, signer),
    timer: new Contract(CONTRACT_ADDRESSES.disclosureTimer, timerAbi.abi, signer),
    keyRegistry: new Contract(CONTRACT_ADDRESSES.keyRegistry, keyRegistryAbi.abi, signer),
    reputation: new Contract(CONTRACT_ADDRESSES.reputation, reputationAbi.abi, signer),
    court: new Contract(CONTRACT_ADDRESSES.court, courtAbi.abi, signer),
  };
}

/** A short, human-readable message from an ethers / wallet error. */
export function errorMessage(err) {
  if (!err) return "Something went wrong";
  if (err.code === "ACTION_REJECTED") return "Transaction rejected in your wallet.";
  return err.reason || err.shortMessage || err.info?.error?.message || err.message || String(err);
}
