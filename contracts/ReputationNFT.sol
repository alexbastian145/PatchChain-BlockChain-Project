// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The slice of the reputation system other PatchChain contracts depend on.
interface IReputation {
    function recordValidated(address researcher, uint8 severity) external;

    function recordRejected(address researcher) external;

    /// @return Basis points of the base stake this researcher must post (10000 = 100%).
    function stakeMultiplierBps(address researcher) external view returns (uint256);
}

/// @title ReputationNFT
/// @notice A soulbound (non-transferable) ERC-721 badge that tracks a researcher's
/// on-chain track record. Reputation is credited automatically by BountyEscrow and
/// StakeManager when reports are validated or rejected — nobody can buy or sell it.
///
/// - The badge is claimed once per address and can never be transferred (ERC-5192).
/// - `tokenURI` is generated fully on-chain: the SVG and JSON reflect the live score.
/// - Rank lowers the stake a researcher must post (see `stakeMultiplierBps`), so a good
///   record has real economic value.
///
/// Scoring: Low +10, Medium +25, High +50, Critical +100, rejected report -15 (floor 0).
/// Ranks:   Rookie < 50 <= Hunter < 150 <= Elite < 400 <= Legend.
/// Stake:   100% / 75% / 50% / 25% of the base stake respectively.
contract ReputationNFT is IReputation {
    string public constant name = "PatchChain Researcher Badge";
    string public constant symbol = "PCRB";

    struct Profile {
        uint256 score;
        uint32 validated;
        uint32 rejected;
        uint32 low;
        uint32 medium;
        uint32 high;
        uint32 critical;
    }

    address public owner;
    mapping(address => bool) public recorders;

    mapping(address => Profile) private _profiles;
    mapping(address => uint256) public tokenIdOf; // 0 = no badge claimed yet
    mapping(uint256 => address) private _owners;
    uint256 public totalSupply;

    // ERC-721
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    // ERC-5192 (minimal soulbound)
    event Locked(uint256 tokenId);
    // PatchChain
    event ReputationUpdated(address indexed researcher, uint256 score, uint8 rank);
    event RecorderSet(address indexed recorder, bool allowed);

    modifier onlyOwner() {
        require(msg.sender == owner, "Reputation: not owner");
        _;
    }

    modifier onlyRecorder() {
        require(recorders[msg.sender], "Reputation: not a recorder");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function setRecorder(address recorder, bool allowed) external onlyOwner {
        recorders[recorder] = allowed;
        emit RecorderSet(recorder, allowed);
    }

    // ---------------------------------------------------------------------
    // Reputation accounting
    // ---------------------------------------------------------------------

    function recordValidated(address researcher, uint8 severity) external onlyRecorder {
        require(severity >= 1 && severity <= 4, "Reputation: severity out of range");
        Profile storage p = _profiles[researcher];
        p.validated += 1;
        if (severity == 1) {
            p.low += 1;
            p.score += 10;
        } else if (severity == 2) {
            p.medium += 1;
            p.score += 25;
        } else if (severity == 3) {
            p.high += 1;
            p.score += 50;
        } else {
            p.critical += 1;
            p.score += 100;
        }
        emit ReputationUpdated(researcher, p.score, rankOf(researcher));
    }

    function recordRejected(address researcher) external onlyRecorder {
        Profile storage p = _profiles[researcher];
        p.rejected += 1;
        p.score = p.score > 15 ? p.score - 15 : 0;
        emit ReputationUpdated(researcher, p.score, rankOf(researcher));
    }

    function profileOf(address researcher) external view returns (Profile memory) {
        return _profiles[researcher];
    }

    function scoreOf(address researcher) external view returns (uint256) {
        return _profiles[researcher].score;
    }

    /// @return 0 Rookie, 1 Hunter, 2 Elite, 3 Legend
    function rankOf(address researcher) public view returns (uint8) {
        uint256 s = _profiles[researcher].score;
        if (s >= 400) return 3;
        if (s >= 150) return 2;
        if (s >= 50) return 1;
        return 0;
    }

    function rankName(uint8 rank) public pure returns (string memory) {
        if (rank == 3) return "Legend";
        if (rank == 2) return "Elite";
        if (rank == 1) return "Hunter";
        return "Rookie";
    }

    function stakeMultiplierBps(address researcher) external view returns (uint256) {
        uint8 rank = rankOf(researcher);
        if (rank == 3) return 2500;
        if (rank == 2) return 5000;
        if (rank == 1) return 7500;
        return 10000;
    }

    // ---------------------------------------------------------------------
    // Soulbound ERC-721
    // ---------------------------------------------------------------------

    /// @notice Claim your badge. One per address, bound to it forever.
    function claim() external returns (uint256 tokenId) {
        require(tokenIdOf[msg.sender] == 0, "Reputation: already claimed");
        tokenId = ++totalSupply;
        tokenIdOf[msg.sender] = tokenId;
        _owners[tokenId] = msg.sender;
        emit Transfer(address(0), msg.sender, tokenId);
        emit Locked(tokenId);
    }

    function balanceOf(address account) external view returns (uint256) {
        require(account != address(0), "Reputation: zero address");
        return tokenIdOf[account] == 0 ? 0 : 1;
    }

    function ownerOf(uint256 tokenId) public view returns (address) {
        address o = _owners[tokenId];
        require(o != address(0), "Reputation: nonexistent token");
        return o;
    }

    /// @notice ERC-5192: this token can never move.
    function locked(uint256 tokenId) external view returns (bool) {
        ownerOf(tokenId);
        return true;
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        ownerOf(tokenId);
        return address(0);
    }

    function isApprovedForAll(address, address) external pure returns (bool) {
        return false;
    }

    function approve(address, uint256) external pure {
        revert("Reputation: soulbound");
    }

    function setApprovalForAll(address, bool) external pure {
        revert("Reputation: soulbound");
    }

    function transferFrom(address, address, uint256) external pure {
        revert("Reputation: soulbound");
    }

    function safeTransferFrom(address, address, uint256) external pure {
        revert("Reputation: soulbound");
    }

    function safeTransferFrom(address, address, uint256, bytes calldata) external pure {
        revert("Reputation: soulbound");
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return
            interfaceId == 0x01ffc9a7 || // ERC-165
            interfaceId == 0x80ac58cd || // ERC-721
            interfaceId == 0x5b5e139f || // ERC-721 Metadata
            interfaceId == 0xb45a3c0e; //   ERC-5192
    }

    // ---------------------------------------------------------------------
    // Fully on-chain metadata
    // ---------------------------------------------------------------------

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        address holder = ownerOf(tokenId);
        Profile memory p = _profiles[holder];
        uint8 rank = rankOf(holder);
        string memory rankLabel = rankName(rank);

        string memory image = string.concat(
            "data:image/svg+xml;base64,",
            _base64(bytes(_svg(holder, p, rank, rankLabel)))
        );

        bytes memory json = abi.encodePacked(
            '{"name":"PatchChain Badge #',
            _toString(tokenId),
            '","description":"Soulbound reputation badge for a PatchChain security researcher. Score and rank update automatically as reports are validated.","image":"',
            image,
            '","attributes":[{"trait_type":"Rank","value":"',
            rankLabel,
            '"},{"trait_type":"Score","value":',
            _toString(p.score),
            '},{"trait_type":"Validated","value":',
            _toString(p.validated),
            '},{"trait_type":"Rejected","value":',
            _toString(p.rejected),
            "}]}"
        );

        return string.concat("data:application/json;base64,", _base64(json));
    }

    function _svg(
        address holder,
        Profile memory p,
        uint8 rank,
        string memory rankLabel
    ) private pure returns (string memory) {
        string memory accent = rank == 3
            ? "#f59e0b"
            : rank == 2
                ? "#a78bfa"
                : rank == 1
                    ? "#38bdf8"
                    : "#94a3b8";

        // Built in small pieces: one giant string.concat overflows the EVM stack.
        string memory frame = string.concat(
            "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 400'>",
            "<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>",
            "<stop offset='0' stop-color='#0b1120'/><stop offset='1' stop-color='#1e1b4b'/>",
            "</linearGradient></defs>",
            "<rect width='400' height='400' rx='28' fill='url(#g)'/>"
        );
        frame = string.concat(
            frame,
            "<rect x='10' y='10' width='380' height='380' rx='20' fill='none' stroke='",
            accent,
            "' stroke-opacity='.45'/>"
        );
        frame = string.concat(
            frame,
            "<path d='M200 70l62 22v52c0 40-26 66-62 82-36-16-62-42-62-82V92z' fill='none' stroke='",
            accent,
            "' stroke-width='5' stroke-linejoin='round'/>",
            "<text x='200' y='44' fill='#c4b5fd' font-family='monospace' font-size='14' text-anchor='middle' letter-spacing='4'>PATCHCHAIN</text>"
        );

        string memory title = string.concat(
            "<text x='200' y='272' fill='#f8fafc' font-family='sans-serif' font-size='46' font-weight='700' text-anchor='middle'>",
            rankLabel,
            "</text><text x='200' y='304' fill='",
            accent,
            "' font-family='monospace' font-size='20' text-anchor='middle'>",
            _toString(p.score),
            " pts</text>"
        );

        string memory footer = string.concat(
            "<text x='200' y='338' fill='#94a3b8' font-family='monospace' font-size='13' text-anchor='middle'>",
            _toString(p.validated),
            " validated / ",
            _toString(p.rejected),
            " rejected</text>"
        );
        footer = string.concat(
            footer,
            "<text x='200' y='366' fill='#64748b' font-family='monospace' font-size='11' text-anchor='middle'>",
            _toHexString(holder),
            "</text></svg>"
        );

        return string.concat(frame, title, footer);
    }

    // ---------------------------------------------------------------------
    // Small string helpers (kept local so the project has no external dependency)
    // ---------------------------------------------------------------------

    function _toString(uint256 value) private pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + (value % 10)));
            value /= 10;
        }
        return string(buffer);
    }

    function _toHexString(address account) private pure returns (string memory) {
        bytes memory alphabet = "0123456789abcdef";
        bytes20 data = bytes20(account);
        bytes memory str = new bytes(42);
        str[0] = "0";
        str[1] = "x";
        for (uint256 i = 0; i < 20; i++) {
            str[2 + i * 2] = alphabet[uint8(data[i] >> 4)];
            str[3 + i * 2] = alphabet[uint8(data[i] & 0x0f)];
        }
        return string(str);
    }

    function _base64(bytes memory data) private pure returns (string memory) {
        if (data.length == 0) return "";
        bytes memory tbl = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        bytes memory out = new bytes(4 * ((data.length + 2) / 3));
        uint256 j = 0;
        uint256 i = 0;

        for (; i + 3 <= data.length; i += 3) {
            uint256 n = (uint256(uint8(data[i])) << 16) |
                (uint256(uint8(data[i + 1])) << 8) |
                uint256(uint8(data[i + 2]));
            out[j++] = tbl[(n >> 18) & 63];
            out[j++] = tbl[(n >> 12) & 63];
            out[j++] = tbl[(n >> 6) & 63];
            out[j++] = tbl[n & 63];
        }

        uint256 rem = data.length - i;
        if (rem == 1) {
            uint256 n1 = uint256(uint8(data[i])) << 16;
            out[j++] = tbl[(n1 >> 18) & 63];
            out[j++] = tbl[(n1 >> 12) & 63];
            out[j++] = "=";
            out[j++] = "=";
        } else if (rem == 2) {
            uint256 n2 = (uint256(uint8(data[i])) << 16) | (uint256(uint8(data[i + 1])) << 8);
            out[j++] = tbl[(n2 >> 18) & 63];
            out[j++] = tbl[(n2 >> 12) & 63];
            out[j++] = tbl[(n2 >> 6) & 63];
            out[j++] = "=";
        }

        return string(out);
    }
}
