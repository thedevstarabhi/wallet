# gas-fund-and-mint (Codespace-ready)

One-file runnable demo:

1. Deploy a minimal ERC-20
2. Create a fresh child wallet
3. Fund child with native gas from the parent
4. Transfer token ownership to the child
5. Mint tokens from the child

## Quickstart (in your Codespace)

```bash
unzip gas-fund-and-mint.zip -d gas-demo && cd gas-demo
npm i
cp .env.example .env
# edit .env with your RPC_URL and PARENT_PK

# run
npm start
```

### Environment variables
See `.env.example` for the full list. Only `RPC_URL` and `PARENT_PK` are required.

### Notes
- Works on any EVM-compatible network (Sepolia recommended for testing).
- Uses **ethers v6** and **solc** to compile & deploy inline Solidity.
- No Hardhat/Foundry needed.
