// resilient-use-deployed-tokentailscat.js
import 'dotenv/config';
import { ethers } from 'ethers';

const {
  RPC_URL,
  PARENT_PK,
  CONTRACT_ADDRESS,
  FUND_CONTRACT = '0.0',
  TOKEN_ID_START = '1',
  TOKEN_SCAN_LIMIT = '1000',
  SKIP_VERIFY = 'false',
  MAX_RETRIES = '5',
} = process.env;

if (!RPC_URL || !PARENT_PK || !CONTRACT_ADDRESS) {
  console.error('Please set RPC_URL, PARENT_PK, CONTRACT_ADDRESS in .env');
  process.exit(1);
}

const ABI = [
  "function owner() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function ownerOf(uint256) view returns (address)",
  "function tokenURI(uint256) view returns (string)",
  "function minter(address) view returns (bool)",
  "function addMinter(address account) external",
  "function removeMinter(address account) external",
  "function distributeIfBelowFromTreasury(address[] recipients, uint256 amount, uint256 threshold) external",
  "function mintUniqueTokenTo(address to, uint256 tokenId) external",
];

// helper: retry wrapper for async provider/contract calls
async function withRetry(fn, attempts = 5, baseDelay = 300) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const delay = baseDelay * Math.pow(2, i); // exponential backoff
      console.log(`RPC call failed (attempt ${i + 1}/${attempts}): ${e.shortMessage || e.message}. Retrying in ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

async function findFreeTokenId(contract, startId, maxTries) {
  for (let i = 0n; i < maxTries; i++) {
    const candidate = startId + i;
    try {
      await withRetry(() => contract.ownerOf(candidate)); // if exists, continue
      continue;
    } catch {
      return candidate;
    }
  }
  throw new Error(`No free tokenId found in range [${startId}..${startId + maxTries - 1n}]`);
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const parent = new ethers.Wallet(PARENT_PK, provider);
  console.log('Parent:', parent.address);

  const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, parent);

  // optionally fund contract treasury
  const fundContractWei = ethers.parseEther(FUND_CONTRACT);
  if (fundContractWei > 0n) {
    console.log(`\nFunding contract treasury with ${FUND_CONTRACT} SEI...`);
    await withRetry(() => parent.sendTransaction({ to: CONTRACT_ADDRESS, value: fundContractWei }).then(tx => tx.wait()));
  }
  const treasury = await withRetry(() => provider.getBalance(CONTRACT_ADDRESS));
  console.log('Contract treasury balance:', ethers.formatEther(treasury), 'SEI');

  // owner display
  try {
    const ownerAddr = await withRetry(() => contract.owner());
    console.log('Contract owner:', ownerAddr);
  } catch (e) {
    console.log('Could not read owner(), continuing. Error:', e.shortMessage || e.message);
  }


  



  // child wallet
  const child = ethers.Wallet.createRandom().connect(provider);
  console.log('\nChild wallet:', child.address);

  // add child as minter (owner required)
  try {
    const isMinter = await withRetry(() => contract.minter(child.address));
    if (!isMinter) {
      console.log('Adding child as minter (owner action)...');
      await withRetry(() => contract.addMinter(child.address).then(tx => tx.wait()));
      console.log('Minter added:', child.address);
    } else {
      console.log('Child already a minter.');
    }
  } catch (e) {
    console.log('addMinter failed (are you the owner?). Error:', e.shortMessage || e.message);
    console.log('You can pre-whitelist the child or fund child off-chain if owner key is not available.');
  }

  // pick free ID
  const startId = BigInt(TOKEN_ID_START);
  const maxTries = BigInt(TOKEN_SCAN_LIMIT);
  let tokenId;
  try {
    tokenId = await findFreeTokenId(contract, startId, maxTries);
    console.log('Using free tokenId:', tokenId.toString());
  } catch (e) {
    console.error('No free token ID found:', e.message);
    process.exit(1);
  }

  // estimate gas for mint (after whitelisting)
  const contractAsChild = contract.connect(child);
  const feeData = await provider.getFeeData();
  const maxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice;
  if (!maxFeePerGas) throw new Error('No fee data from RPC');

  let gasLimit;
  try {
    gasLimit = await withRetry(() => contractAsChild.mintUniqueTokenTo.estimateGas(child.address, tokenId, { from: child.address }));
    console.log('Estimated gasLimit:', gasLimit.toString());
  } catch (e) {
    console.log('estimateGas failed, using conservative fallback 120000', e.shortMessage || e.message);
    gasLimit = 120000n;
  }

  const estCost = gasLimit * maxFeePerGas;
  const buffer = estCost / 5n; // +20%
  const totalRequired = estCost + buffer;

  let childBal = await withRetry(() => provider.getBalance(child.address));
  let needed = totalRequired > childBal ? (totalRequired - childBal) : 0n;

  if (needed > 0n) {
    console.log(`Auto-funding child via treasury: send ${ethers.formatEther(needed)} SEI`);
    try {
      const threshold = childBal + 1n;
      await withRetry(() => contract.distributeIfBelowFromTreasury([child.address], needed, threshold).then(tx => tx.wait()));
      childBal = await withRetry(() => provider.getBalance(child.address));
      console.log('Child balance after top-up:', ethers.formatEther(childBal), 'SEI');
    } catch (e) {
      console.log('distributeIfBelowFromTreasury failed:', e.shortMessage || e.message);
      console.log('Fallback: please fund child with native gas off-chain to proceed');
    }
  } else {
    console.log('Child already has sufficient gas.');
  }

  // prepare explicit gas params for mint tx
  // set maxFeePerGas slightly above current (20% buffer)
  const maxFeeForTx = maxFeePerGas + (maxFeePerGas / 5n);

  // Do the mint with explicit gasLimit + maxFeePerGas
  let mintTxHash;
  try {
    const tx = await contractAsChild.mintUniqueTokenTo(child.address, tokenId, {
      gasLimit: gasLimit,
      maxFeePerGas: maxFeeForTx,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? undefined,
    });
    const receipt = await withRetry(() => tx.wait());
    mintTxHash = receipt.transactionHash;
    console.log('mintUniqueTokenTo tx:', mintTxHash);
  } catch (e) {
    console.log('Mint failed:', e.shortMessage || e.message);
    console.log('If this was due to RPC busyness, try rerunning; the mint may have actually gone through (check the tx pool / explorer).');
    process.exit(1);
  }

  // verification (optional)
  if (SKIP_VERIFY === 'true') {
    console.log('SKIP_VERIFY=true, skipping ownerOf/tokenURI checks.');
    return;
  }

  try {
    const newOwner = await withRetry(() => contract.ownerOf(tokenId), Number(MAX_RETRIES));
    const bal = await withRetry(() => contract.balanceOf(child.address), Number(MAX_RETRIES));
    let uri = '(no tokenURI)';
    try {
      uri = await withRetry(() => contract.tokenURI(tokenId), Number(MAX_RETRIES));
    } catch {}
    console.log('\n=== Final State ===');
    console.log('Token ID:', tokenId.toString());
    console.log('Owner   :', newOwner);
    console.log('Balance :', bal.toString());
    console.log('tokenURI:', uri);
  } catch (e) {
    console.log('Final verification failed due to RPC; but mint tx was submitted:', mintTxHash);
    console.log('If needed, check the contract on-chain or re-run with SKIP_VERIFY=true.');
  }
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
