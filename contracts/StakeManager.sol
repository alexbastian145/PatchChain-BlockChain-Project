// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./VulnerabilityRegistry.sol";
import "./ReputationNFT.sol";

/// @title StakeManager
/// @notice Requires a researcher to stake a small deposit when submitting a report,
/// discouraging spam/duplicate submissions. The deposit is refunded on a valid
/// report and forfeited (sent to the organization) on a rejected/spam report.
///
/// Researchers with a good track record (see ReputationNFT) post a reduced stake:
/// 100% / 75% / 50% / 25% of the base amount by rank.
contract StakeManager {
    VulnerabilityRegistry public registry;
    IReputation public reputation; // optional; address(0) disables stake discounts
    address public owner;

    uint256 public requiredStake; // base stake, in wei

    enum StakeState {
        None,
        Staked,
        Refunded,
        Forfeited
    }

    mapping(uint256 => StakeState) public stakeState;
    mapping(uint256 => uint256) public stakedAmount;

    event StakeDeposited(uint256 indexed reportId, address indexed researcher, uint256 amount);
    event StakeRefunded(uint256 indexed reportId, address indexed researcher, uint256 amount);
    event StakeForfeited(uint256 indexed reportId, address indexed organization, uint256 amount);
    event RequiredStakeUpdated(uint256 newAmount);
    event ReputationSet(address indexed reputation);

    modifier onlyOwner() {
        require(msg.sender == owner, "StakeManager: not owner");
        _;
    }

    constructor(address registryAddress, uint256 _requiredStake) {
        require(registryAddress != address(0), "StakeManager: invalid registry");
        registry = VulnerabilityRegistry(registryAddress);
        owner = msg.sender;
        requiredStake = _requiredStake;
    }

    function setRequiredStake(uint256 newAmount) external onlyOwner {
        requiredStake = newAmount;
        emit RequiredStakeUpdated(newAmount);
    }

    function setReputation(address reputationAddress) external onlyOwner {
        reputation = IReputation(reputationAddress);
        emit ReputationSet(reputationAddress);
    }

    /// @notice The exact stake this researcher must send, after any reputation discount.
    function requiredStakeFor(address researcher) public view returns (uint256) {
        if (address(reputation) == address(0)) return requiredStake;
        return (requiredStake * reputation.stakeMultiplierBps(researcher)) / 10000;
    }

    /// @notice Submit a report together with the required stake, in one transaction.
    function submitReportWithStake(
        address organization,
        bytes32 reportHash,
        string calldata ipfsCID
    ) external payable returns (uint256 reportId) {
        require(msg.value == requiredStakeFor(msg.sender), "StakeManager: incorrect stake amount");

        reportId = registry.submitReportFor(msg.sender, organization, reportHash, ipfsCID);
        stakeState[reportId] = StakeState.Staked;
        stakedAmount[reportId] = msg.value;

        emit StakeDeposited(reportId, msg.sender, msg.value);
    }

    /// @notice Refund the researcher's stake once a report is validated as legitimate.
    /// Callable by the organization the report was submitted to.
    function refundStake(uint256 reportId) external {
        VulnerabilityRegistry.Report memory r = registry.getReport(reportId);
        require(msg.sender == r.organization, "StakeManager: not the organization");
        require(stakeState[reportId] == StakeState.Staked, "StakeManager: no active stake");

        stakeState[reportId] = StakeState.Refunded;
        uint256 amount = stakedAmount[reportId];
        stakedAmount[reportId] = 0;

        (bool sent, ) = r.researcher.call{value: amount}("");
        require(sent, "StakeManager: refund transfer failed");

        emit StakeRefunded(reportId, r.researcher, amount);
    }

    /// @notice Forfeit the stake to the organization when a report is rejected as spam/invalid.
    function forfeitStake(uint256 reportId) external {
        VulnerabilityRegistry.Report memory r = registry.getReport(reportId);
        require(msg.sender == r.organization, "StakeManager: not the organization");
        require(stakeState[reportId] == StakeState.Staked, "StakeManager: no active stake");

        stakeState[reportId] = StakeState.Forfeited;
        uint256 amount = stakedAmount[reportId];
        stakedAmount[reportId] = 0;

        (bool sent, ) = r.organization.call{value: amount}("");
        require(sent, "StakeManager: forfeit transfer failed");

        // A spam strike counts against the researcher's reputation. Never let a
        // reputation failure block the forfeit itself.
        if (address(reputation) != address(0)) {
            try reputation.recordRejected(r.researcher) {} catch {}
        }

        emit StakeForfeited(reportId, r.organization, amount);
    }

    receive() external payable {}
}
