// SPDX-License-Identifier: MIT
// gas-fund-and-mint.js — ERC721 (Kazar) using contract treasury to fund child
import 'dotenv/config';
import { ethers } from 'ethers';
import solc from 'solc';
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// ----- ENV -----
const RPC_URL      = process.env.RPC_URL;
const PARENT_PK    = process.env.PARENT_PK;

const FUND_CONTRACT= process.env.FUND_CONTRACT || '1.0';      // SEI -> contract
const TOPUP_AMOUNT = process.env.TOPUP_AMOUNT  || '0.0002';   // SEI -> child from contract
const THRESHOLD    = process.env.THRESHOLD     || '0.0001';   // child bal threshold
const TOKEN_ID     = process.env.TOKEN_ID      || '1';









// ----- Solidity (Kazar) -----
const source = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Strings.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

error NotOwner();
error NonexistentToken();
error NotMinter();
error LengthMismatch();
error SweepFailed();
error InsufficientTreasury();

contract Kazar is ERC721, Ownable, ReentrancyGuard {
    mapping(address => bool) public minter;
    event MinterAdded(address indexed account);
    event MinterRemoved(address indexed account);
    event Checked(address indexed player, uint256 indexed tokenId);
    string private constant BASE = "https://api.kazar.space/new/";

    constructor() ERC721("KAZAR", "KZR") {
        minter[msg.sender] = true;
    }

    function mintUniqueTokenTo(address to, uint256 tokenId) external {
        if (!minter[msg.sender]) revert NotMinter();
        _mint(to, tokenId);
    }

    receive() external payable {}
    fallback() external payable {}

    function mintToMany(
        address[] calldata addresses,
        uint256[] calldata tokenIds
    ) external {
        if (!minter[msg.sender]) revert NotMinter();
        if (addresses.length != tokenIds.length) revert LengthMismatch();
        unchecked {
            for (uint256 i = 0; i < addresses.length; ++i) {
                if (_exists(tokenIds[i])) { continue; }
                _mint(addresses[i], tokenIds[i]);
            }
        }
    }

    function addMinter(address account) external onlyOwner {
        minter[account] = true;
        emit MinterAdded(account);
    }

    function removeMinter(address account) external onlyOwner {
        if (!minter[account]) revert NotMinter();
        delete minter[account];
        emit MinterRemoved(account);
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        if (!_exists(tokenId)) revert NonexistentToken();
        return string(abi.encodePacked(BASE, Strings.toString(tokenId)));
    }

    function checkIn(uint256 tokenId) external {
        if (ownerOf(tokenId) != msg.sender) revert NotOwner();
        emit Checked(msg.sender, tokenId);
    }

    function sweep(address payable to, uint256 value) external onlyOwner nonReentrant {
        (bool ok, ) = to.call{value: value}("");
        if (!ok) revert SweepFailed();
    }

    function distributeIfBelowFromTreasury(
        address payable[] calldata recipients,
        uint256 amount,
        uint256 threshold
    ) external onlyOwner nonReentrant {
        uint256 len = recipients.length;
        uint256 need;
        unchecked {
            for (uint256 i = 0; i < len; ++i) {
                if (recipients[i].balance < threshold) need += amount;
            }
        }
        if (address(this).balance < need) revert InsufficientTreasury();

        for (uint256 i = 0; i < len; ++i) {
            address payable to = recipients[i];
            if (to == address(0)) continue;
            if (to.balance < threshold) {
                (bool ok, ) = to.call{value: amount}("");
                ok; // touch var
            }
        }
    }
}
`;

// ----- solc import resolver -----
function findImports(importPath) {
  try {
    const resolved = require.resolve(importPath, { paths: [process.cwd()] });
    return { contents: fs.readFileSync(resolved, 'utf8') };
  } catch (e) {
    return { error: 'File not found: ' + importPath };
  }
}

// ----- compile -----
function compile(src) {
  const input = {
    language: 'Solidity',
    sources: { 'Kazar.sol': { content: src } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } }
    }
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
  if (output.errors) {
    const errs = output.errors.filter(e => e.severity === 'error');
    if (errs.length) throw new Error(errs.map(e => e.formattedMessage).join('\n'));
  }
  const c = output.contracts['Kazar.sol']['Kazar'];
  return { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
}

async function main() {
  if (!RPC_URL || !PARENT_PK) {
    console.error('Set RPC_URL and PARENT_PK in .env');
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const parent = new ethers.Wallet(PARENT_PK, provider);
  console.log('Parent:', parent.address);

  const { abi, bytecode } = compile(source);

  // 1) Deploy
  console.log('\nDeploying Kazar...');
  const factory = new ethers.ContractFactory(abi, bytecode, parent);
  const contract = await factory.deploy();
  await contract.waitForDeployment();
  const nft = contract.target;
  console.log('NFT deployed at:', nft);

  // 2) Fund contract treasury with FUND_CONTRACT SEI
  const fundValue = ethers.parseEther(FUND_CONTRACT);
  const fundTx = await parent.sendTransaction({ to: nft, value: fundValue });
  await fundTx.wait();
  const contractBal = await provider.getBalance(nft);
  console.log('Contract funded. Treasury balance:', ethers.formatEther(contractBal), 'SEI');

  // 3) Create child wallet (no direct funding from parent)
  const child = ethers.Wallet.createRandom().connect(provider);
  console.log('\nChild wallet:', child.address);
  const childBalStart = await provider.getBalance(child.address);
  console.log('Child start balance:', ethers.formatEther(childBalStart), 'SEI');

  // 4) From owner, call distributeIfBelowFromTreasury to top-up child
  const asOwner = new ethers.Contract(nft, abi, parent);
  const recipients = [child.address];
  const amount    = ethers.parseEther(TOPUP_AMOUNT);
  const threshold = ethers.parseEther(THRESHOLD);





console.log(`Top-up via contract treasury if child < ${THRESHOLD} SEI ...`);

// get fee hints from the provider, but fall back to safe defaults if null
const feeData = await provider.getFeeData();
const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? ethers.parseUnits("1", "gwei");
const maxFeePerGas = feeData.maxFeePerGas ?? ethers.parseUnits("50", "gwei");

// manual gas limit to bypass eth_estimateGas (200k is reasonable for single recipient)
const gasLimit = 200_000;

console.log("Sending distributeIfBelowFromTreasury with manual gasLimit and fees...");
const distTx = await asOwner.distributeIfBelowFromTreasury(
  recipients,
  amount,
  threshold,
  { gasLimit, maxPriorityFeePerGas, maxFeePerGas }
);
await distTx.wait();
console.log("distributeIfBelowFromTreasury tx mined:", distTx.hash);






  const childBalAfter = await provider.getBalance(child.address);
  console.log('Child balance after distribute:', ethers.formatEther(childBalAfter), 'SEI');

  // 5) Add child as minter (owner action)
  const addTx = await asOwner.addMinter(child.address);
  await addTx.wait();
  console.log('Minter added:', child.address);

  // 6) Child mints NFT to itself
  const tokenId = BigInt(TOKEN_ID);
  const asChild = new ethers.Contract(nft, abi, child);
  const mintTx = await asChild.mintUniqueTokenTo(child.address, tokenId);
  const mintRcpt = await mintTx.wait();
  console.log('mintUniqueTokenTo tx:', mintRcpt.hash);

  // 7) Verify
  const owner = await asChild.ownerOf(tokenId);
  const uri = await asChild.tokenURI(tokenId);
  const balance = await asChild.balanceOf(child.address);

  console.log('\n=== Final State ===');
  console.log('Token ID:', tokenId.toString());
  console.log('Owner   :', owner);
  console.log('Balance :', balance.toString());
  console.log('tokenURI:', uri);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
