// index.js — TokenTailsCat REST API with GET-friendly endpoints
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { ethers } from 'ethers';
import fse from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

// ----- Setup paths -----
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const DB_DIR     = path.join(__dirname, 'db');
const USERS_DB   = path.join(DB_DIR, 'users.json');

// ----- Env -----
const {
  RPC_URL,
  PARENT_PK,
  CONTRACT_ADDRESS,
  PORT = '3000',
  TOPUP_BUFFER_BPS = '200',     // +20% buffer on gas estimate (basis points)
  FALLBACK_GAS_LIMIT = '120000' // used if estimateGas fails (BigInt)
} = process.env;

if (!RPC_URL || !PARENT_PK || !CONTRACT_ADDRESS) {
  console.error('Set RPC_URL, PARENT_PK, CONTRACT_ADDRESS in .env');
  process.exit(1);
}

// ----- Minimal ABI for TokenTailsCat -----
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
  "function checkIn(uint256 tokenId) external"
];

// ----- Chain objects -----
const provider = new ethers.JsonRpcProvider(RPC_URL);
const owner    = new ethers.Wallet(PARENT_PK, provider);
const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, owner);

// ----- Local JSON DB (dev only) -----
await fse.ensureDir(DB_DIR);
if (!(await fse.pathExists(USERS_DB))) await fse.writeJson(USERS_DB, { users: {} }, { spaces: 2 });

async function loadDB()  { return fse.readJson(USERS_DB); }
async function saveDB(db) { return fse.writeJson(USERS_DB, db, { spaces: 2 }); }
function upsertUser(db, username, wallet) { db.users[username] = wallet; return db; }
function getUser(db, username) { return db.users[username] || null; }

// ----- Helpers -----
function param(req, key, fallback = undefined) {
  // Prefer query for GET, then body for POST
  if (req.query?.[key] !== undefined) return req.query[key];
  if (req.body?.[key]  !== undefined) return req.body[key];
  return fallback;
}

async function findFreeTokenId(start = 1n, limit = 1000n) {
  for (let i = 0n; i < limit; i++) {
    const id = start + i;
    try { await contract.ownerOf(id); } // exists -> continue
    catch { return id; }                 // revert -> free
  }
  throw new Error(`No free tokenId in range [${start}..${start + limit - 1n}]`);
}

async function ensureMinter(address) {
  const isMinter = await contract.minter(address);
  if (!isMinter) {
    const tx = await contract.addMinter(address);
    await tx.wait();
  }
}

async function autoTopUpFromTreasury(childAddr, contractAsChild, tokenId) {
  const fee = await provider.getFeeData();
  const maxFeePerGas = fee.maxFeePerGas ?? fee.gasPrice;
  if (!maxFeePerGas) throw new Error('No fee data from RPC');

  let gasLimit;
  try {
    gasLimit = await contractAsChild.mintUniqueTokenTo.estimateGas(childAddr, tokenId, { from: childAddr });
  } catch {
    gasLimit = BigInt(FALLBACK_GAS_LIMIT);
  }
  const estCost = gasLimit * maxFeePerGas;
  const buffer  = (estCost * BigInt(TOPUP_BUFFER_BPS)) / 10000n;
  const total   = estCost + buffer;

  const bal = await provider.getBalance(childAddr);
  if (bal >= total) return { funded: false, sent: 0n, total };

  const needed = total - bal;
  const threshold = bal + 1n; // ensure condition triggers

  const tx = await contract.distributeIfBelowFromTreasury([childAddr], needed, threshold);
  await tx.wait();

  const balAfter = await provider.getBalance(childAddr);
  return { funded: true, sent: needed, total, balAfter };
}

// ----- Server -----
const app = express();
app.use(cors());
app.use(express.json());

// Root index (quick links)
app.get('/', async (_req, res) => {
  res.type('html').send(`
  <h2>TokenTailsCat REST API</h2>
  <ul>
    <li>Health: <code>/health</code></li>
    <li>Create user: <code>/api/user/create?username=player_123</code></li>
    <li>Get user: <code>/api/user/player_123</code></li>
    <li>Fund contract: <code>/api/contract/fund?amount=0.5</code></li>
    <li>Mint (auto ID): <code>/api/mint?username=player_123</code></li>
    <li>Mint (pick range): <code>/api/mint?username=player_123&startId=1&scanLimit=1000</code></li>
    <li>Check-in: <code>/api/checkin?username=player_123&tokenId=42</code></li>
  </ul>
  `);
});

// Health
app.get('/health', async (_req, res) => {
  try {
    const [net, ownerAddr, treas] = await Promise.all([
      provider._network, contract.owner(), provider.getBalance(CONTRACT_ADDRESS)
    ]);
    res.json({ ok: true, chainId: net.chainId, contract: CONTRACT_ADDRESS, owner: ownerAddr, treasury: ethers.formatEther(treas) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Create user wallet (GET/POST)
// GET  /api/user/create?username=player_123
// POST /api/user/create { "username": "player_123" }
app.all('/api/user/create', async (req, res) => {
  try {
    const username = param(req, 'username');
    if (!username) return res.status(400).json({ ok: false, error: 'username required' });

    const db = await loadDB();
    if (db.users[username]) {
      return res.json({ ok: true, message: 'exists', address: db.users[username].address });
    }
    const wallet = ethers.Wallet.createRandom();
    const record = { address: wallet.address, privateKey: wallet.privateKey }; // WARNING: dev-only
    upsertUser(db, username, record);
    await saveDB(db);

    res.json({ ok: true, address: record.address });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Get user address
// GET /api/user/:username
app.get('/api/user/:username', async (req, res) => {
  try {
    const db = await loadDB();
    const u = getUser(db, req.params.username);
    if (!u) return res.status(404).json({ ok: false, error: 'not found' });
    res.json({ ok: true, address: u.address });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Fund contract treasury (GET/POST)
// GET  /api/contract/fund?amount=0.5
// POST /api/contract/fund { "amount": "0.5" }
app.all('/api/contract/fund', async (req, res) => {
  try {
    const amount = param(req, 'amount');
    if (!amount) return res.status(400).json({ ok: false, error: 'amount required' });
    const wei = ethers.parseEther(String(amount));
    const tx  = await owner.sendTransaction({ to: CONTRACT_ADDRESS, value: wei });
    const rcpt = await tx.wait();
    const bal = await provider.getBalance(CONTRACT_ADDRESS);
    res.json({ ok: true, hash: rcpt.hash, treasury: ethers.formatEther(bal) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Add minter (GET/POST)
// GET  /api/contract/add-minter?username=player_123
// POST /api/contract/add-minter { "username": "player_123" }
app.all('/api/contract/add-minter', async (req, res) => {
  try {
    const username = param(req, 'username');
    if (!username) return res.status(400).json({ ok: false, error: 'username required' });

    const db = await loadDB();
    const u  = getUser(db, username);
    if (!u) return res.status(404).json({ ok: false, error: 'user not found' });

    await ensureMinter(u.address);
    res.json({ ok: true, minter: u.address });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Mint NFT (GET/POST). If tokenId omitted, finds a free one.
// GET  /api/mint?username=player_123&tokenId=123
// GET  /api/mint?username=player_123&startId=1&scanLimit=1000
// POST /api/mint { "username":"player_123", "tokenId":123 }
// --- Robust /api/mint handler (replace existing handler) ---
app.all('/api/mint', async (req, res) => {
  try {
    const username  = param(req, 'username');
    const tokenIdQ  = param(req, 'tokenId');
    const startIdQ  = param(req, 'startId');
    const scanLimQ  = param(req, 'scanLimit');
    if (!username) return res.status(400).json({ ok: false, error: 'username required' });

    const db = await loadDB();
    const u  = getUser(db, username);
    if (!u) return res.status(404).json({ ok: false, error: 'user not found' });

    const user = new ethers.Wallet(u.privateKey, provider);
    const asUser = contract.connect(user);

    // 1) Ensure minter (owner call)
    try {
      await ensureMinter(user.address);
    } catch (e) {
      // don't fail hard here — include warning and continue.
      console.warn('ensureMinter warning:', e.shortMessage || e.message);
    }

    // 2) Pick tokenId (find free if not provided)
    let id;
    try {
      id = tokenIdQ ? BigInt(tokenIdQ) : await findFreeTokenId(BigInt(startIdQ || 1), BigInt(scanLimQ || 1000));
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'failed to pick tokenId', detail: e.message });
    }

    // 3) Auto top-up from treasury if needed
    let topupResult = null;
    try {
      topupResult = await autoTopUpFromTreasury(user.address, asUser, id);
    } catch (e) {
      // log but continue — user may already have gas or you may manually fund
      console.warn('autoTopUpFromTreasury warning:', e.shortMessage || e.message);
      topupResult = { funded: false, error: e.shortMessage || e.message };
    }

    // 4) Mint: send tx and wait for it to be mined. Return tx.hash even if later reads fail.
    let tx, rcpt;
    try {
      tx = await asUser.mintUniqueTokenTo(user.address, id);
      // wait for miner to include the tx. You can also use tx.wait() (alias)
      rcpt = await tx.wait();
    } catch (e) {
      // If the provider returns a low-level call exception with no revert data, e.message may contain "missing revert data"
      // Return helpful debug info including any RPC 'data' if present.
      const debug = {};
      if (e.transaction) debug.transaction = e.transaction;
      if (e.data) debug.data = e.data;
      console.error('Mint tx error:', e);
      return res.status(500).json({ ok: false, error: 'mint transaction failed', detail: e.shortMessage || e.message, debug });
    }

    // 5) Attempt verification reads but don't fail hard if they error.
    let verification = {};
    try {
      verification.owner = await contract.ownerOf(id);
    } catch (e) {
      verification.ownerError = e.shortMessage || e.message || String(e);
      // If some nodes return empty revert data, try fetching the receipt and rely on that
      try {
        const receipt = await provider.getTransactionReceipt(rcpt.transactionHash ?? tx.hash);
        verification.receipt = {
          txHash: receipt.transactionHash,
          status: receipt.status,
          blockNumber: receipt.blockNumber,
          gasUsed: receipt.gasUsed?.toString?.() ?? String(receipt.gasUsed)
        };
      } catch (inner) {
        verification.receiptError = inner.shortMessage || inner.message || String(inner);
      }
    }

    try {
      verification.balance = (await contract.balanceOf(user.address)).toString();
    } catch (e) {
      verification.balanceError = e.shortMessage || e.message;
    }

    try {
      verification.tokenURI = await contract.tokenURI(id);
    } catch (e) {
      verification.tokenURIError = e.shortMessage || e.message;
    }

    // 6) Return success with tx hash + best-effort verification details
    return res.json({
      ok: true,
      txHash: rcpt.transactionHash ?? tx.hash,
      tokenId: id.toString(),
      topup: topupResult,
      verification
    });

  } catch (e) {
    // fallback: include any shortMessage & message and raw error
    console.error('Unhandled /api/mint error:', e);
    return res.status(500).json({ ok: false, error: e.shortMessage || e.message || String(e) });
  }
});


// Check-in (GET/POST)
// GET  /api/checkin?username=player_123&tokenId=42
// POST /api/checkin { "username":"player_123","tokenId":42 }
app.all('/api/checkin', async (req, res) => {
  try {
    const username = param(req, 'username');
    const tokenId  = param(req, 'tokenId');
    if (!username || tokenId === undefined) {
      return res.status(400).json({ ok: false, error: 'username and tokenId required' });
    }

    const db = await loadDB();
    const u = getUser(db, username);
    if (!u) return res.status(404).json({ ok: false, error: 'user not found' });

    const user = new ethers.Wallet(u.privateKey, provider);
    const asUser = contract.connect(user);

    const tx = await asUser.checkIn(BigInt(tokenId));
    const rcpt = await tx.wait();
    res.json({ ok: true, tx: rcpt.hash });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.shortMessage || e.message });
  }
});


// --- Fix BigInt serialization globally ---
BigInt.prototype.toJSON = function () {
  return this.toString();
};



app.listen(Number(PORT), () => {
  console.log(`API listening on :${PORT}`);
  console.log(`Open in browser: http://localhost:${PORT}/`);
});
