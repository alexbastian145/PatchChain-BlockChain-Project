// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./VulnerabilityRegistry.sol";
import "./BountyEscrow.sol";

/// @title DisclosureTimer
/// @notice Starts a countdown when a report is submitted. If the organization
/// has not reached a final payout/rejection decision before the deadline,
/// anyone can trigger automatic public disclosure of the report's existence
/// (the registry's status is flipped to Disclosed — the encrypted IPFS content
/// itself is revealed off-chain by releasing the decryption key at this point).
contract DisclosureTimer {
    VulnerabilityRegistry public registry;
    BountyEscrow public escrow;
    address public owner;

    uint256 public disclosureWindow; // seconds, e.g. 90 days = 7776000

    mapping(uint256 => uint256) public deadline; // reportId => unix timestamp
    mapping(uint256 => bool) public disclosed;

    // Content keys published after disclosure, so anyone can decrypt the (public) report.
    mapping(uint256 => bytes32) public disclosureKey;
    mapping(uint256 => bool) public keyPublished;

    event DeadlineSet(uint256 indexed reportId, uint256 deadline);
    event AutoDisclosed(uint256 indexed reportId, uint256 disclosedAt);
    event DisclosureKeyPublished(uint256 indexed reportId, bytes32 contentKey);
    event DisclosureWindowUpdated(uint256 newWindow);

    modifier onlyOwner() {
        require(msg.sender == owner, "Timer: not owner");
        _;
    }

    constructor(address registryAddress, address escrowAddress, uint256 _disclosureWindow) {
        require(registryAddress != address(0), "Timer: invalid registry");
        require(escrowAddress != address(0), "Timer: invalid escrow");
        registry = VulnerabilityRegistry(registryAddress);
        escrow = BountyEscrow(escrowAddress);
        owner = msg.sender;
        disclosureWindow = _disclosureWindow;
    }

    function setDisclosureWindow(uint256 newWindow) external onlyOwner {
        disclosureWindow = newWindow;
        emit DisclosureWindowUpdated(newWindow);
    }

    /// @notice Starts (or restarts) the disclosure countdown for a report.
    /// Can be called by the researcher right after submission.
    function startTimer(uint256 reportId) external {
        VulnerabilityRegistry.Report memory r = registry.getReport(reportId);
        require(msg.sender == r.researcher, "Timer: not the researcher");
        require(deadline[reportId] == 0, "Timer: already started");

        deadline[reportId] = block.timestamp + disclosureWindow;
        emit DeadlineSet(reportId, deadline[reportId]);
    }

    /// @notice Anyone can call this once the deadline has passed and the report
    /// has still not been settled (paid or rejected). Flips status to Disclosed.
    function triggerAutoDisclosure(uint256 reportId) external {
        require(deadline[reportId] != 0, "Timer: not started");
        require(block.timestamp >= deadline[reportId], "Timer: deadline not reached");
        require(!disclosed[reportId], "Timer: already disclosed");

        BountyEscrow.PayoutState state = escrow.payoutState(reportId);
        require(state == BountyEscrow.PayoutState.NotPaid, "Timer: already settled");

        disclosed[reportId] = true;
        registry.updateStatus(reportId, VulnerabilityRegistry.Status.Disclosed);

        emit AutoDisclosed(reportId, block.timestamp);
    }

    /// @notice Reports are end-to-end encrypted, so disclosure needs someone who can
    /// actually decrypt to release the key. Only the researcher (who always holds the
    /// content key) can do so, and only once the report is marked Disclosed. Publishing
    /// the symmetric content key makes the report permanently readable by anyone:
    /// the researcher's right to disclose after the deadline, enforced without a server.
    function publishDisclosureKey(uint256 reportId, bytes32 contentKey) external {
        VulnerabilityRegistry.Report memory r = registry.getReport(reportId);
        require(msg.sender == r.researcher, "Timer: not the researcher");
        require(r.status == VulnerabilityRegistry.Status.Disclosed, "Timer: report not disclosed");
        require(!keyPublished[reportId], "Timer: key already published");
        require(contentKey != bytes32(0), "Timer: empty key");

        keyPublished[reportId] = true;
        disclosureKey[reportId] = contentKey;
        emit DisclosureKeyPublished(reportId, contentKey);
    }

    function timeRemaining(uint256 reportId) external view returns (uint256) {
        if (deadline[reportId] == 0) return disclosureWindow;
        if (block.timestamp >= deadline[reportId]) return 0;
        return deadline[reportId] - block.timestamp;
    }
}
