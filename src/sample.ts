export const SAMPLE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract Ownable {
    address public owner;

    event OwnershipTransferred(address indexed from, address indexed to);

    error NotOwner(address caller);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function transferOwnership(address next) external onlyOwner {
        require(next != address(0), "zero");
        emit OwnershipTransferred(owner, next);
        owner = next;
    }
}

contract Vault is Ownable {
    struct Position {
        uint128 shares;
        uint64 openedAt;
        bool locked;
    }

    uint256 public constant FEE_BPS = 30;
    IERC20 public immutable asset;

    uint256 public totalShares;
    uint96 public totalFees;
    bool public paused;
    mapping(address => Position) public positions;
    address[] public depositors;

    event Deposit(address indexed user, uint256 amount, uint256 shares);
    event Withdraw(address indexed user, uint256 shares);

    modifier whenNotPaused() {
        require(!paused, "paused");
        _;
    }

    constructor(IERC20 asset_) {
        asset = asset_;
    }

    function deposit(uint256 amount) external payable whenNotPaused returns (uint256 shares) {
        require(amount > 0, "amount");
        uint256 fee = (amount * FEE_BPS) / 10_000;
        shares = amount - fee;

        asset.transferFrom(msg.sender, address(this), amount);

        Position storage p = positions[msg.sender];
        if (p.shares == 0) {
            depositors.push(msg.sender);
            p.openedAt = uint64(block.timestamp);
        }
        p.shares += uint128(shares);
        totalShares += shares;
        totalFees += uint96(fee);

        emit Deposit(msg.sender, amount, shares);
    }

    function withdraw(uint128 shares) external whenNotPaused {
        Position storage p = positions[msg.sender];
        require(!p.locked, "locked");
        require(p.shares >= shares, "balance");
        unchecked {
            p.shares -= shares;
        }
        totalShares -= shares;
        asset.transfer(msg.sender, shares);
        emit Withdraw(msg.sender, shares);
    }

    function sharesOf(address user) external view returns (uint256) {
        return positions[user].shares;
    }

    function activeDepositors() external view returns (uint256 count) {
        for (uint256 i = 0; i < depositors.length; i++) {
            if (positions[depositors[i]].shares > 0) {
                count++;
            }
        }
    }

    function setPaused(bool value) external onlyOwner {
        paused = value;
    }

    function previewFee(uint256 amount) public pure returns (uint256) {
        return (amount * FEE_BPS) / 10_000;
    }
}

contract Router {
    Vault public immutable vault;
    IERC20 public immutable token;

    constructor(Vault vault_, IERC20 token_) {
        vault = vault_;
        token = token_;
    }

    function depositFor(uint256 amount) external returns (uint256) {
        require(token.balanceOf(msg.sender) >= amount, "funds");
        uint256 fee = vault.previewFee(amount);
        return vault.deposit(amount - fee);
    }

    function preview(uint256 amount) external view returns (uint256) {
        return amount - vault.previewFee(amount);
    }
}
`

/** FNV-1a hash of the previous built-in sample, so a stored copy of it is upgraded instead of kept. */
export const OLD_SAMPLE_HASHES = ['d7b8b882']

export function hashText(s: string) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return (h >>> 0).toString(16)
}
