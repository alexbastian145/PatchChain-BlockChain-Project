import { useCallback, useEffect, useState } from "react";
import { BrowserProvider } from "ethers";

/**
 * Connects to MetaMask and exposes a live ethers provider/signer plus the
 * connected address. Re-syncs automatically if the user switches accounts
 * or networks in MetaMask itself.
 */
export function useWallet() {
  const [address, setAddress] = useState(null);
  const [provider, setProvider] = useState(null);
  const [signer, setSigner] = useState(null);
  const [chainId, setChainId] = useState(null);
  const [error, setError] = useState(null);

  const connect = useCallback(async () => {
    setError(null);
    if (!window.ethereum) {
      setError("MetaMask not detected. Please install the MetaMask browser extension.");
      return;
    }
    try {
      const browserProvider = new BrowserProvider(window.ethereum);
      await browserProvider.send("eth_requestAccounts", []);
      const signerInstance = await browserProvider.getSigner();
      const addr = await signerInstance.getAddress();
      const network = await browserProvider.getNetwork();

      setProvider(browserProvider);
      setSigner(signerInstance);
      setAddress(addr);
      setChainId(Number(network.chainId));
    } catch (err) {
      setError(err.message || "Failed to connect wallet");
    }
  }, []);

  const clear = useCallback(() => {
    setAddress(null);
    setProvider(null);
    setSigner(null);
    setChainId(null);
  }, []);

  const disconnect = useCallback(() => {
    clear();
    // Best effort: also revoke the site's access, so the next "Connect" shows MetaMask's
    // account picker instead of silently reusing the previously connected account.
    window.ethereum
      ?.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] })
      .catch(() => {});
  }, [clear]);

  /** Opens MetaMask's account picker so a different account can be connected to this site. */
  const switchAccount = useCallback(async () => {
    setError(null);
    if (!window.ethereum) {
      setError("MetaMask not detected. Please install the MetaMask browser extension.");
      return;
    }
    try {
      await window.ethereum.request({
        method: "wallet_requestPermissions",
        params: [{ eth_accounts: {} }],
      });
      await connect();
    } catch (err) {
      if (err?.code !== 4001) setError(err.message || "Failed to switch account"); // 4001 = user closed the picker
    }
  }, [connect]);

  useEffect(() => {
    if (!window.ethereum) return;

    const handleAccountsChanged = (accounts) => {
      if (accounts.length === 0) {
        clear();
      } else {
        connect();
      }
    };
    const handleChainChanged = () => {
      connect();
    };

    window.ethereum.on("accountsChanged", handleAccountsChanged);
    window.ethereum.on("chainChanged", handleChainChanged);

    return () => {
      window.ethereum.removeListener("accountsChanged", handleAccountsChanged);
      window.ethereum.removeListener("chainChanged", handleChainChanged);
    };
  }, [connect, clear]);

  return { address, provider, signer, chainId, error, connect, disconnect, switchAccount };
}
