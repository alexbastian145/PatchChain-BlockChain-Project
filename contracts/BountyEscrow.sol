// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./VulnerabilityRegistry.sol";
import "./ReputationNFT.sol";

/// @title BountyEscrow
/// @notice Lets an organization fund a severity-tiered bounty pool, then
/// automatically releases the correct payout to a researcher once their
/// report is validated and assigned a severity level.
///
/// Disputes are resolved by the `arbitrator`. In a full PatchChain deployment that is
/// the ArbitrationCourt contract (a staked, commit-reveal jury), not a single account.
contract BountyEscrow {
    VulnerabilityRegistry public registry;
    IReputation public reputation; // optional; address(0) disables reputation credits
    address public owner;

    // organization => severity tier (1-4) => bounty amount in wei
    mapping(address => mapping(uint8 => uint256)) public bountyTiers;
    // organization => funded balance available for payouts
    mapping(address => uint256) public orgBalance;

    enum PayoutState {
        NotPaid,
        Paid,
        Disputed
    }
    mapping(uint256 => PayoutState) public payoutState;

    event Funded(address indexed organization, uint256 amount);
    event BountyTierSet(address indexed organization, uint8 severity, uint256 amount);
    event BountyReleased(uint256 indexed reportId, address indexed researcher, uint8 severity, uint256 amount);
    event DisputeRaised(uint256 indexed reportId, address indexed raisedBy);
    event DisputeResolved(uint256 indexed reportId, bool paidToResearcher);

    address public arbitrator;

    modifier onlyOwner() {
        require(msg.sender == owner, "Escrow: not owner");
        _;
    }

    modifier onlyArbitrator() {
        require(msg.sender == arbitrator, "Escrow: not arbitrator");
        _;
    }

    constructor(address registryAddress, address arbitratorAddress) {
        require(registryAddress != address(0), "Escrow: invalid registry");
        registry = VulnerabilityRegistry(registryAddress);
        owner = msg.sender;
        arbitrator = arbitratorAddress;
    }

    function setArbitrator(address newArbitrator) external onlyOwner {
        arbitrator = newArbitrator;
    }

    function setReputation(address reputationAddress) external onlyOwner {
        reputation = IReputation(reputationAddress);
    }

    // Reputation credits must never be able to block a payout, hence try/catch.
    function _creditValidated(address researcher, uint8 severity) private {
        if (address(reputation) != address(0)) {
            try reputation.recordValidated(researcher, severity) {} catch {}
        }
    }

    function _creditRejected(address researcher) private {
        if (address(reputation) != address(0)) {
            try reputation.recordRejected(researcher) {} catch {}
        }
    }

    /// @notice Organization deposits funds into its bounty pool.
    function fund() external payable {
        require(msg.value > 0, "Escrow: zero funding");
        orgBalance[msg.sender] += msg.value;
        emit Funded(msg.sender, msg.value);
    }

    /// @notice Organization sets the payout amount for each severity tier (1=Low .. 4=Critical).
    function setBountyTier(uint8 severity, uint256 amount) external {
        require(severity >= 1 && severity <= 4, "Escrow: severity out of range");
        bountyTiers[msg.sender][severity] = amount;
        emit BountyTierSet(msg.sender, severity, amount);
    }

    /// @notice Organization approves a validated report at a given severity,
    /// automatically releasing the corresponding bounty to the researcher.
    function approveAndPay(uint256 reportId, uint8 severity) external {
        VulnerabilityRegistry.Report memory r = registry.getReport(reportId);
        require(msg.sender == r.organization, "Escrow: not the organization");
        require(payoutState[reportId] == PayoutState.NotPaid, "Escrow: already settled");
        require(severity >= 1 && severity <= 4, "Escrow: severity out of range");

        uint256 amount = bountyTiers[r.organization][severity];
        require(amount > 0, "Escrow: bounty tier not set");
        require(orgBalance[r.organization] >= amount, "Escrow: insufficient organization balance");

        orgBalance[r.organization] -= amount;
        payoutState[reportId] = PayoutState.Paid;

        registry.setSeverity(reportId, severity);
        registry.updateStatus(reportId, VulnerabilityRegistry.Status.Validated);

        (bool sent, ) = r.researcher.call{value: amount}("");
        require(sent, "Escrow: payout transfer failed");

        _creditValidated(r.researcher, severity);

        emit BountyReleased(reportId, r.researcher, severity, amount);
    }

    /// @notice Either party can escalate a disagreement over validity/severity to the arbitrator.
    function raiseDispute(uint256 reportId) external {
        VulnerabilityRegistry.Report memory r = registry.getReport(reportId);
        require(
            msg.sender == r.researcher || msg.sender == r.organization,
            "Escrow: not a party to this report"
        );
        require(payoutState[reportId] == PayoutState.NotPaid, "Escrow: already settled");

        payoutState[reportId] = PayoutState.Disputed;
        emit DisputeRaised(reportId, msg.sender);
    }

    /// @notice Arbitrator resolves a dispute, optionally forcing payout at a given severity.
    function resolveDispute(uint256 reportId, bool payResearcher, uint8 severity) external onlyArbitrator {
        require(payoutState[reportId] == PayoutState.Disputed, "Escrow: not disputed");
        VulnerabilityRegistry.Report memory r = registry.getReport(reportId);

        if (payResearcher) {
            require(severity >= 1 && severity <= 4, "Escrow: severity out of range");
            uint256 amount = bountyTiers[r.organization][severity];
            require(amount > 0, "Escrow: bounty tier not set");
            require(orgBalance[r.organization] >= amount, "Escrow: insufficient organization balance");

            orgBalance[r.organization] -= amount;
            payoutState[reportId] = PayoutState.Paid;
            registry.setSeverity(reportId, severity);
            registry.updateStatus(reportId, VulnerabilityRegistry.Status.Validated);

            (bool sent, ) = r.researcher.call{value: amount}("");
            require(sent, "Escrow: payout transfer failed");

            _creditValidated(r.researcher, severity);

            emit BountyReleased(reportId, r.researcher, severity, amount);
        } else {
            payoutState[reportId] = PayoutState.NotPaid;
            registry.updateStatus(reportId, VulnerabilityRegistry.Status.Rejected);
            _creditRejected(r.researcher);
        }

        emit DisputeResolved(reportId, payResearcher);
    }
}
