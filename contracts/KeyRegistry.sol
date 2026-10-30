// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title KeyRegistry
/// @notice Public directory of end-to-end-encryption public keys.
///
/// Researchers encrypt reports in the browser to the *organization's* key, which they
/// look up here, so the PatchChain backend never sees report plaintext. Jurors register
/// a key too, so a party to a dispute can re-wrap the report's content key for the panel.
///
/// Keys are 32-byte X25519 public keys. Clients derive the matching private key
/// deterministically from a wallet signature, so there is nothing extra to back up.
contract KeyRegistry {
    mapping(address => bytes32) public publicKeyOf;

    event KeyRegistered(address indexed account, bytes32 publicKey);

    /// @notice Publish (or replace) the caller's encryption public key.
    /// @dev Replacing a key does not affect reports already encrypted to the old one.
    function registerKey(bytes32 publicKey) external {
        require(publicKey != bytes32(0), "KeyRegistry: empty key");
        publicKeyOf[msg.sender] = publicKey;
        emit KeyRegistered(msg.sender, publicKey);
    }

    function hasKey(address account) external view returns (bool) {
        return publicKeyOf[account] != bytes32(0);
    }
}
