// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./VulnerabilityRegistry.sol";
import "./BountyEscrow.sol";
import "./KeyRegistry.sol";

/// @title ArbitrationCourt
/// @notice Decentralized dispute resolution for PatchChain. Replaces the single
/// trusted arbitrator account with a pool of staked jurors who vote in secret.
///
/// Lifecycle of a case
///   1. A party to a disputed report opens a case and pays the arbitration fee.
///   2. A panel of jurors is drawn pseudo-randomly from the pool (parties are excluded)
///      and each locks part of their stake.
///   3. Evidence phase: the parties publish evidence (an IPFS CID). Because reports are
///      end-to-end encrypted, a party re-wraps the report's content key for the drawn
///      jurors' registered keys (see KeyRegistry) and posts that bundle here.
///   4. Commit phase: each juror submits keccak256(caseId, juror, ruling, salt).
///   5. Reveal phase: jurors reveal; the commit must match.
///   6. Finalize: the majority ruling is executed on BountyEscrow. Jurors who did not
///      reveal, or voted against the majority, lose the stake locked for the case; the
///      slashed stake plus the arbitration fee is shared among the coherent jurors.
///
/// Ruling: 0 = reject the report (no payout); 1..4 = pay the researcher at that severity.
/// The paid severity is the lower median of the severities chosen by the "pay" voters.
///
/// Security notes (honest limitations):
///   - Juror selection uses blockhash as its randomness source. That is fine for a
///     testnet or demo, but a production deployment should use a VRF (e.g. Chainlink).
///   - There is no appeal round yet; a tie or a no-show quorum voids the case, refunds
///     the fee, and lets a party open a new case for the same dispute.
contract ArbitrationCourt {
    BountyEscrow public immutable escrow;
    VulnerabilityRegistry public immutable registry;
    KeyRegistry public immutable keyRegistry;

    uint256 public immutable panelSize; // odd number of jurors per case
    uint256 public immutable jurorDeposit; // minimum deposit to join the pool
    uint256 public immutable caseLock; // stake locked per case, at risk of slashing
    uint256 public immutable arbitrationFee; // paid by whoever opens a case
    uint256 public immutable evidencePeriod; // seconds
    uint256 public immutable commitPeriod; // seconds
    uint256 public immutable revealPeriod; // seconds

    // ---- juror pool ----
    address[] private _pool;
    mapping(address => uint256) private _poolIndexPlusOne;
    mapping(address => uint256) public balanceOf; // juror funds held by the court
    mapping(address => uint256) public lockedOf; // portion locked in open cases
    mapping(address => uint256) public refundOf; // fee refunds / compensation owed to non-jurors

    // ---- cases ----
    enum Status {
        Open, // fee paid, waiting for the juror draw
        Drawn, // panel selected, evidence/commit/reveal in progress
        Decided, // majority ruling reached
        Voided // tie or no quorum; fee refunded
    }

    enum Phase {
        Open,
        Evidence,
        Commit,
        Reveal,
        AwaitingFinalize,
        Decided,
        Voided
    }

    struct Case {
        uint256 reportId;
        address opener;
        Status status;
        uint64 openedBlock;
        uint64 evidenceEnd;
        uint64 commitEnd;
        uint64 revealEnd;
        bool payResearcher;
        uint8 severity;
        bool executed;
        address[] jurors;
    }

    struct Vote {
        bytes32 commit;
        uint8 ruling;
        bool committed;
        bool revealed;
    }

    struct Evidence {
        address party;
        string cid;
        uint64 at;
    }

    uint256 public caseCount;
    mapping(uint256 => Case) private _cases;
    mapping(uint256 => uint256) public activeCaseOf; // reportId => caseId + 1
    mapping(uint256 => mapping(address => bool)) public isPanelist;
    mapping(uint256 => mapping(address => Vote)) private _votes;
    mapping(uint256 => uint256) public revealedCount;
    mapping(uint256 => Evidence[]) private _evidence;

    event JurorJoined(address indexed juror, uint256 amount);
    event JurorLeft(address indexed juror, uint256 amount);
    event JurorFunded(address indexed juror, uint256 amount);
    event CaseOpened(uint256 indexed caseId, uint256 indexed reportId, address indexed opener);
    event JurorsDrawn(uint256 indexed caseId, address[] jurors);
    event EvidenceSubmitted(uint256 indexed caseId, address indexed party, string cid);
    event VoteCommitted(uint256 indexed caseId, address indexed juror);
    event VoteRevealed(uint256 indexed caseId, address indexed juror, uint8 ruling);
    event CaseDecided(uint256 indexed caseId, bool payResearcher, uint8 severity);
    event CaseVoided(uint256 indexed caseId);
    event CaseExecuted(uint256 indexed caseId);
    event JurorSlashed(uint256 indexed caseId, address indexed juror, uint256 amount);
    event JurorRewarded(uint256 indexed caseId, address indexed juror, uint256 amount);

    constructor(
        address escrowAddress,
        address keyRegistryAddress,
        uint256 _panelSize,
        uint256 _jurorDeposit,
        uint256 _caseLock,
        uint256 _arbitrationFee,
        uint256 _evidencePeriod,
        uint256 _commitPeriod,
        uint256 _revealPeriod
    ) {
        require(escrowAddress != address(0) && keyRegistryAddress != address(0), "Court: zero address");
        require(_panelSize >= 1 && _panelSize % 2 == 1, "Court: panel size must be odd");
        require(_caseLock > 0 && _jurorDeposit >= _caseLock, "Court: deposit must cover case lock");
        require(_commitPeriod > 0 && _revealPeriod > 0, "Court: zero voting period");

        escrow = BountyEscrow(escrowAddress);
        registry = BountyEscrow(escrowAddress).registry();
        keyRegistry = KeyRegistry(keyRegistryAddress);
        panelSize = _panelSize;
        jurorDeposit = _jurorDeposit;
        caseLock = _caseLock;
        arbitrationFee = _arbitrationFee;
        evidencePeriod = _evidencePeriod;
        commitPeriod = _commitPeriod;
        revealPeriod = _revealPeriod;
    }

    // ---------------------------------------------------------------------
    // Juror pool
    // ---------------------------------------------------------------------

    /// @notice Join the jury by depositing at least `jurorDeposit`. You must have
    /// registered an encryption key so parties can share evidence with you privately.
    function joinJury() external payable {
        require(_poolIndexPlusOne[msg.sender] == 0, "Court: already a juror");
        require(msg.value >= jurorDeposit, "Court: deposit too small");
        require(keyRegistry.hasKey(msg.sender), "Court: register an encryption key first");

        _pool.push(msg.sender);
        _poolIndexPlusOne[msg.sender] = _pool.length;
        balanceOf[msg.sender] += msg.value;

        emit JurorJoined(msg.sender, msg.value);
    }

    /// @notice Add to your deposit (e.g. after being slashed) so you stay draw-eligible.
    function addStake() external payable {
        require(_poolIndexPlusOne[msg.sender] != 0, "Court: not a juror");
        require(msg.value > 0, "Court: zero amount");
        balanceOf[msg.sender] += msg.value;
        emit JurorFunded(msg.sender, msg.value);
    }

    /// @notice Leave the jury and withdraw everything. Only possible with no open cases.
    function leaveJury() external {
        uint256 idxPlusOne = _poolIndexPlusOne[msg.sender];
        require(idxPlusOne != 0, "Court: not a juror");
        require(lockedOf[msg.sender] == 0, "Court: stake locked in a case");

        uint256 last = _pool.length - 1;
        uint256 idx = idxPlusOne - 1;
        if (idx != last) {
            address moved = _pool[last];
            _pool[idx] = moved;
            _poolIndexPlusOne[moved] = idx + 1;
        }
        _pool.pop();
        _poolIndexPlusOne[msg.sender] = 0;

        uint256 amount = balanceOf[msg.sender];
        balanceOf[msg.sender] = 0;
        _send(msg.sender, amount);

        emit JurorLeft(msg.sender, amount);
    }

    /// @notice Withdraw rewards or surplus stake that is not locked in a case.
    function withdraw(uint256 amount) external {
        require(amount > 0, "Court: zero amount");
        require(balanceOf[msg.sender] - lockedOf[msg.sender] >= amount, "Court: exceeds free balance");
        balanceOf[msg.sender] -= amount;
        _send(msg.sender, amount);
    }

    /// @notice Claim fee refunds / compensation credited to you as a non-juror.
    function claimRefund() external {
        uint256 amount = refundOf[msg.sender];
        require(amount > 0, "Court: nothing to claim");
        refundOf[msg.sender] = 0;
        _send(msg.sender, amount);
    }

    function isJuror(address account) public view returns (bool) {
        return _poolIndexPlusOne[account] != 0;
    }

    function jurorCount() external view returns (uint256) {
        return _pool.length;
    }

    function _isEligible(address account) private view returns (bool) {
        return isJuror(account) && balanceOf[account] - lockedOf[account] >= caseLock;
    }

    // ---------------------------------------------------------------------
    // Opening a case and drawing the panel
    // ---------------------------------------------------------------------

    /// @notice Open an arbitration case for a report that has been disputed on BountyEscrow.
    function openCase(uint256 reportId) external payable returns (uint256 caseId) {
        require(msg.value == arbitrationFee, "Court: incorrect fee");
        require(
            escrow.payoutState(reportId) == BountyEscrow.PayoutState.Disputed,
            "Court: report not disputed"
        );

        VulnerabilityRegistry.Report memory r = registry.getReport(reportId);
        require(msg.sender == r.researcher || msg.sender == r.organization, "Court: not a party");

        uint256 active = activeCaseOf[reportId];
        if (active != 0) {
            require(_cases[active - 1].status == Status.Voided, "Court: case already active");
        }
        require(_pool.length >= panelSize + 2, "Court: not enough jurors");

        caseId = caseCount++;
        Case storage c = _cases[caseId];
        c.reportId = reportId;
        c.opener = msg.sender;
        c.status = Status.Open;
        c.openedBlock = uint64(block.number);
        activeCaseOf[reportId] = caseId + 1;

        emit CaseOpened(caseId, reportId, msg.sender);
    }

    /// @notice Draw the jury panel. Callable by anyone, from the block after the case opened.
    function drawJurors(uint256 caseId) external {
        require(caseId < caseCount, "Court: unknown case");
        Case storage c = _cases[caseId];
        require(c.status == Status.Open, "Court: already drawn");
        require(block.number > c.openedBlock, "Court: wait one block");

        VulnerabilityRegistry.Report memory r = registry.getReport(c.reportId);
        uint256 n = _pool.length;
        bytes32 seed = keccak256(abi.encode(blockhash(block.number - 1), caseId, c.reportId));

        uint256 chosen = 0;
        uint256 attempts = 0;
        while (chosen < panelSize) {
            require(attempts < panelSize * 40, "Court: not enough eligible jurors");
            seed = keccak256(abi.encode(seed, attempts));
            attempts++;

            address candidate = _pool[uint256(seed) % n];
            if (
                candidate == r.researcher ||
                candidate == r.organization ||
                isPanelist[caseId][candidate] ||
                !_isEligible(candidate)
            ) {
                continue;
            }

            isPanelist[caseId][candidate] = true;
            c.jurors.push(candidate);
            lockedOf[candidate] += caseLock;
            chosen++;
        }

        c.status = Status.Drawn;
        c.evidenceEnd = uint64(block.timestamp + evidencePeriod);
        c.commitEnd = uint64(block.timestamp + evidencePeriod + commitPeriod);
        c.revealEnd = uint64(block.timestamp + evidencePeriod + commitPeriod + revealPeriod);

        emit JurorsDrawn(caseId, c.jurors);
    }

    // ---------------------------------------------------------------------
    // Evidence
    // ---------------------------------------------------------------------

    /// @notice A party posts evidence (an IPFS CID). For an encrypted report, this is the
    /// envelope re-wrapped for the drawn jurors' keys.
    function submitEvidence(uint256 caseId, string calldata cid) external {
        require(caseId < caseCount, "Court: unknown case");
        Case storage c = _cases[caseId];
        require(c.status == Status.Drawn, "Court: not accepting evidence");
        require(block.timestamp <= c.evidenceEnd, "Court: evidence period over");
        require(bytes(cid).length > 0 && bytes(cid).length <= 128, "Court: invalid CID");

        VulnerabilityRegistry.Report memory r = registry.getReport(c.reportId);
        require(msg.sender == r.researcher || msg.sender == r.organization, "Court: not a party");

        _evidence[caseId].push(Evidence({party: msg.sender, cid: cid, at: uint64(block.timestamp)}));
        emit EvidenceSubmitted(caseId, msg.sender, cid);
    }

    // ---------------------------------------------------------------------
    // Commit-reveal voting
    // ---------------------------------------------------------------------

    /// @notice Hash a vote exactly as `commitVote`/`revealVote` expect (handy for clients and tests).
    function hashVote(uint256 caseId, address juror, uint8 ruling, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(caseId, juror, ruling, salt));
    }

    function commitVote(uint256 caseId, bytes32 commit) external {
        require(caseId < caseCount, "Court: unknown case");
        Case storage c = _cases[caseId];
        require(c.status == Status.Drawn, "Court: not in voting");
        require(isPanelist[caseId][msg.sender], "Court: not on this panel");
        require(block.timestamp > c.evidenceEnd, "Court: evidence period still open");
        require(block.timestamp <= c.commitEnd, "Court: commit period over");
        require(commit != bytes32(0), "Court: empty commit");

        Vote storage v = _votes[caseId][msg.sender];
        v.commit = commit;
        v.committed = true;

        emit VoteCommitted(caseId, msg.sender);
    }

    function revealVote(uint256 caseId, uint8 ruling, bytes32 salt) external {
        require(caseId < caseCount, "Court: unknown case");
        Case storage c = _cases[caseId];
        require(c.status == Status.Drawn, "Court: not in voting");
        require(isPanelist[caseId][msg.sender], "Court: not on this panel");
        require(block.timestamp > c.commitEnd, "Court: commit period still open");
        require(block.timestamp <= c.revealEnd, "Court: reveal period over");
        require(ruling <= 4, "Court: invalid ruling");

        Vote storage v = _votes[caseId][msg.sender];
        require(v.committed, "Court: no commit");
        require(!v.revealed, "Court: already revealed");
        require(hashVote(caseId, msg.sender, ruling, salt) == v.commit, "Court: reveal does not match commit");

        v.revealed = true;
        v.ruling = ruling;
        revealedCount[caseId] += 1;

        emit VoteRevealed(caseId, msg.sender, ruling);
    }

    // ---------------------------------------------------------------------
    // Settlement
    // ---------------------------------------------------------------------

    /// @notice Tally the votes, settle juror stakes and execute the ruling. Callable by
    /// anyone once the reveal period ends (or sooner, if every juror has revealed).
    function finalize(uint256 caseId) external {
        require(caseId < caseCount, "Court: unknown case");
        Case storage c = _cases[caseId];
        require(c.status == Status.Drawn, "Court: not in voting");
        require(
            block.timestamp > c.revealEnd || revealedCount[caseId] == c.jurors.length,
            "Court: voting still open"
        );

        (bool decided, bool payResearcher, uint8 severity) = _tally(caseId);
        _settle(caseId, decided, payResearcher);

        if (decided) {
            c.status = Status.Decided;
            c.payResearcher = payResearcher;
            c.severity = severity;
            emit CaseDecided(caseId, payResearcher, severity);
            _execute(caseId);
        } else {
            c.status = Status.Voided;
            refundOf[c.opener] += arbitrationFee;
            emit CaseVoided(caseId);
        }
    }

    /// @notice If executing the ruling on BountyEscrow failed (e.g. the organization's
    /// balance was too low or its bounty tier was unset), retry once that is fixed.
    function retryExecute(uint256 caseId) external {
        require(caseId < caseCount, "Court: unknown case");
        Case storage c = _cases[caseId];
        require(c.status == Status.Decided && !c.executed, "Court: nothing to execute");
        _execute(caseId);
        require(c.executed, "Court: execution failed");
    }

    function _tally(uint256 caseId) private view returns (bool decided, bool payResearcher, uint8 severity) {
        Case storage c = _cases[caseId];
        uint256 n = c.jurors.length;
        uint256 payVotes = 0;
        uint256 rejectVotes = 0;
        uint8[] memory sevs = new uint8[](n);

        for (uint256 i = 0; i < n; i++) {
            Vote storage v = _votes[caseId][c.jurors[i]];
            if (!v.revealed) continue;
            if (v.ruling == 0) {
                rejectVotes++;
            } else {
                sevs[payVotes] = v.ruling;
                payVotes++;
            }
        }

        if (payVotes > rejectVotes) {
            // insertion sort the (tiny) list of severities, take the lower median
            for (uint256 i = 1; i < payVotes; i++) {
                uint8 key = sevs[i];
                uint256 j = i;
                while (j > 0 && sevs[j - 1] > key) {
                    sevs[j] = sevs[j - 1];
                    j--;
                }
                sevs[j] = key;
            }
            return (true, true, sevs[(payVotes - 1) / 2]);
        }
        if (rejectVotes > payVotes) {
            return (true, false, 0);
        }
        return (false, false, 0); // tie or no reveals
    }

    function _settle(uint256 caseId, bool decided, bool payResearcher) private {
        Case storage c = _cases[caseId];
        uint256 n = c.jurors.length;

        address[] memory winners = new address[](n);
        uint256 winCount = 0;
        uint256 slashed = 0;

        for (uint256 i = 0; i < n; i++) {
            address juror = c.jurors[i];
            Vote storage v = _votes[caseId][juror];
            lockedOf[juror] -= caseLock;

            bool coherent = v.revealed && (!decided || (payResearcher ? v.ruling >= 1 : v.ruling == 0));
            if (coherent) {
                winners[winCount++] = juror;
            } else {
                balanceOf[juror] -= caseLock;
                slashed += caseLock;
                emit JurorSlashed(caseId, juror, caseLock);
            }
        }

        // Fee goes to the jury only when it actually delivered a ruling; otherwise it is refunded.
        uint256 pot = slashed + (decided ? arbitrationFee : 0);
        if (pot == 0) return;

        if (winCount == 0) {
            // Nobody revealed: the no-shows' slashed stake compensates the party who paid for the case.
            refundOf[c.opener] += pot;
            return;
        }

        uint256 share = pot / winCount;
        uint256 dust = pot - share * winCount;
        for (uint256 i = 0; i < winCount; i++) {
            uint256 reward = share + (i == 0 ? dust : 0);
            balanceOf[winners[i]] += reward;
            emit JurorRewarded(caseId, winners[i], reward);
        }
    }

    function _execute(uint256 caseId) private {
        Case storage c = _cases[caseId];
        c.executed = true; // set first; reverted below if the escrow call fails (re-entrancy safe)
        try escrow.resolveDispute(c.reportId, c.payResearcher, c.severity) {
            emit CaseExecuted(caseId);
        } catch {
            c.executed = false;
        }
    }

    function _send(address to, uint256 amount) private {
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "Court: transfer failed");
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getCase(uint256 caseId) external view returns (Case memory) {
        require(caseId < caseCount, "Court: unknown case");
        return _cases[caseId];
    }

    function getJurors(uint256 caseId) external view returns (address[] memory) {
        require(caseId < caseCount, "Court: unknown case");
        return _cases[caseId].jurors;
    }

    function getEvidence(uint256 caseId) external view returns (Evidence[] memory) {
        require(caseId < caseCount, "Court: unknown case");
        return _evidence[caseId];
    }

    function getVote(uint256 caseId, address juror) external view returns (Vote memory) {
        return _votes[caseId][juror];
    }

    function phaseOf(uint256 caseId) external view returns (Phase) {
        require(caseId < caseCount, "Court: unknown case");
        Case storage c = _cases[caseId];
        if (c.status == Status.Open) return Phase.Open;
        if (c.status == Status.Decided) return Phase.Decided;
        if (c.status == Status.Voided) return Phase.Voided;
        if (block.timestamp <= c.evidenceEnd) return Phase.Evidence;
        if (block.timestamp <= c.commitEnd) return Phase.Commit;
        if (block.timestamp <= c.revealEnd) return Phase.Reveal;
        return Phase.AwaitingFinalize;
    }
}
