---
name: "o1.exchange Trading API"
description: "Execute trades on o1.exchange with MEV protection, gasless approvals, and multi-network support for Base and BSC"
version: "1.1.0"
author: "o1.exchange"
tags: ["trading", "defi", "blockchain", "api", "crypto"]
---

# o1.exchange Trading API Skill

This skill enables Claude Code to interact with the o1.exchange trading API to execute buy/sell orders on supported blockchain networks with enterprise-grade features.

> **⚠️ This skill moves real funds.** The sample script loads a wallet private key
> into memory and broadcasts irreversible, value-moving transactions on Base and
> BSC mainnets. Read the [Security](#security) section before running it, and
> configure the trusted-contract allowlist it requires.

## Features

- **Multi-Network Support**: Trade on Base (ETH) and BSC (BNB) networks
- **MEV Protection**: Built-in sandwich attack prevention through private mempool routing
- **Gasless Approvals**: One-time Permit2 signatures for unlimited trading
- **Fixed Slippage Protection**: 3% (300 bps) tolerance
- **Real-time Balance Tracking**: Pre and post-trade balance monitoring
- **Interactive CLI**: User-friendly command-line interface
- **Fail-Closed Safety Gate**: Every server-supplied transaction is validated against an operator-configured contract allowlist before it is signed

## Prerequisites

### Install

```bash
npm ci
```

`package.json` pins exact dependency versions and `package-lock.json` is committed, so
`npm ci` installs a reproducible tree. There is no fallback to `npm install`.

### Environment Variables

Create a `.env.local` file in the repository root. This file contains a live private
key — it is covered by `.gitignore` and **must never be committed**.

```env
EXECUTE_TRADE_PRIVATE_KEY=your_wallet_private_key_here
EXECUTE_TRADE_API_TOKEN=your_o1_exchange_api_token_here
EXECUTE_TRADE_BASE_URL=https://api.o1.exchange
EXECUTE_TRADE_BASE_RPC_URL=your_base_rpc_url_here
EXECUTE_TRADE_BSC_RPC_URL=your_bsc_rpc_url_here

# REQUIRED to trade. Comma-separated, checksummed contract addresses that this
# script is permitted to sign for. While empty, every trade is refused.
EXECUTE_TRADE_TRUSTED_CONTRACTS_BASE=0x...,0x...
EXECUTE_TRADE_TRUSTED_CONTRACTS_BSC=0x...,0x...

# Optional
EXECUTE_TRADE_MAX_NOTIONAL=1
EXECUTE_TRADE_DRY_RUN=0
EXECUTE_TRADE_HTTP_TIMEOUT_MS=20000
```

### Dependencies

Installed automatically by `npm ci`; declared in `package.json`:

- `axios` — HTTP client for API calls
- `ethers` — EVM library for wallet management and transaction signing
- `dotenv` — environment variable management
- `node:readline` — **built into Node.js**, not an npm package. Do not install it.

Requires Node.js `>= 20.19` (per `engines` in `package.json`), because the project
uses ES modules.

## API Endpoints

### Create Order
- **Endpoint**: `POST /api/v2/order`
- **Purpose**: Create a new trading order
- **Parameters**:
  - `signerAddress`: Wallet address for signing transactions
  - `tokenAddress`: ERC-20 token contract address (0x + 40 hex characters)
  - `uiAmount`: Amount as a plain positive decimal string (e.g. `"0.1"`)
  - `direction`: `"buy"` or `"sell"`
  - `slippageBps`: Slippage tolerance in basis points (the CLI sends 300 = 3%)
  - `mevProtection`: Boolean for MEV protection (recommended: `true`)
  - `networkId`: Network chain ID (Base: 8453, BSC: 56)

The CLI also sends an `Idempotency-Key` header derived from the order parameters, so a
retried request cannot execute the same order twice.

### Complete Order
- **Endpoint**: `POST /api/v2/order/complete`
- **Purpose**: Submit signed transactions to complete the order
- **Parameters**:
  - `id`: Order ID from the create-order response
  - `transactions`: Array of signed transaction objects

## Usage Examples

### Interactive Trading Session

```bash
npm start
# or: node sampleScripts/execute-trade-interactive.js
```

The script will prompt for:
1. Network selection (base/bsc)
2. Token contract address
3. Trade direction (buy/sell)
4. Amount
5. Trade confirmation

### Dry run

Set `EXECUTE_TRADE_DRY_RUN=1` to exercise the flow without creating or signing
anything:

```bash
EXECUTE_TRADE_DRY_RUN=1 npm start
```

### Programmatic order creation

The API is plain HTTP and can be called directly. Note that **any client which signs
the API's response must perform the same allowlist validation** described under
[Security](#security) — the signature is what makes the transaction binding.

```javascript
const orderResponse = await axios.post(`${BASE_URL}/api/v2/order`, {
  signerAddress: wallet.address,
  tokenAddress: "0x1111111111166b7fe7bd91427724b487980afc69", // Zora on Base
  uiAmount: "0.1",
  direction: "buy",
  slippageBps: 300,
  mevProtection: true,
  networkId: 8453,
}, {
  headers: { Authorization: `Bearer ${API_TOKEN}` },
  timeout: 20000,
});
```

## Supported Networks

### Base Network
- **Chain ID**: 8453
- **Native Currency**: ETH
- **RPC**: Configure `EXECUTE_TRADE_BASE_RPC_URL`
- **Example Token**: Zora (0x1111111111166b7fe7bd91427724b487980afc69)

### BSC Network
- **Chain ID**: 56
- **Native Currency**: BNB
- **RPC**: Configure `EXECUTE_TRADE_BSC_RPC_URL`
- **Example Token**: USDT (0x55d398326f99059ff775485246999027b3197955)

Solana is **not** supported. An earlier revision of this document advertised Solana
(chain ID 1399811149) and an `EXECUTE_TRADE_SOLANA_RPC_URL` variable; no Solana code
path exists in this repository and those references have been removed.

## Security

### The API response is untrusted input

The signing flow necessarily trusts the server for transaction *content*. This skill
treats that content as hostile until validated. Before any signature is produced,
`execute-trade-interactive.js` asserts:

1. `chainId` equals the network the operator selected;
2. the transaction's `to` address is in the operator-configured allowlist for that network;
3. the Permit2 EIP-712 `domain.chainId` and `domain.verifyingContract` match that allowlist;
4. the Permit2 spender is allowlisted (it is read from `values.spender`,
   `values.permitted.spender`, `values.allowed.spender` or `values.permit.spender`,
   since the field is nested differently per witness type);
5. the Permit2 permitted amount is at least the amount the operator confirmed;
6. the EIP-712 type set is one of the recognised Permit2 witness types;
7. native `value` is within `EXECUTE_TRADE_MAX_NOTIONAL`;
8. the gas limit is within a sanity ceiling and the nonce is non-negative;
9. the signature placeholder appears **exactly once** in calldata, so substitution
   can never silently no-op.

Any failed assertion raises `UnsafeTransactionError`, prints a `🛑 BLOCKED by safety
check` message and aborts without signing.

### Fail-closed by default

If `EXECUTE_TRADE_TRUSTED_CONTRACTS_BASE` / `_BSC` is unset, the allowlist is empty and
**every trade is refused**. There is no permissive fallback. Invalid or
non-checksummed entries are dropped with a warning rather than silently widening the
allowlist.

### Agent permission scope

This skill performs value-moving actions. When enabling it in an agent harness:

- require explicit human confirmation immediately before each signature — the CLI
  already prompts, and the prompt must not be auto-answered;
- set `EXECUTE_TRADE_MAX_NOTIONAL` to the smallest acceptable per-trade ceiling;
- use `EXECUTE_TRADE_DRY_RUN=1` for any validation, demonstration or test pass;
- grant filesystem read access to `.env.local` only when a real trade is intended.

### EIP-712 / Permit2

- Typed-data signing is used for Permit2 gasless approvals.
- The Permit2 signature is a **standing spending allowance**, not a one-time
  authorisation. Treat its domain, verifying contract, spender and amount as
  security-critical and keep them inside the allowlist.

## Error Handling

Common error scenarios:

- **`🛑 BLOCKED by safety check`** — the server returned a transaction that failed the
  allowlist or sanity checks. Nothing was signed. Investigate before retrying.
- **`Invalid API token` / "Unauthorized"** — check `EXECUTE_TRADE_API_TOKEN`.
- **`No trusted contracts configured`** — set the allowlist variable for that network.
- **`Invalid amount`** — amounts must be plain positive decimals (`0.01`); exponent
  notation, `Infinity` and trailing characters are rejected.
- **`Invalid token address`** — must match `0x` + 40 hex characters and pass checksum validation.
- **`Transaction failed`** — check network connectivity and gas.

Outbound requests use a 20 s timeout with up to 3 bounded retries with jitter.
Mutating requests carry an idempotency key, so a retry cannot double-execute.

## Code Structure

```
sampleScripts/
└── execute-trade-interactive.js   # Interactive trading CLI (the only executable)

Key functions in execute-trade-interactive.js:
├── assertTransactionIsSafe()     # Allowlist + sanity gate for each unsigned tx
├── assertPermit2IsSafe()         # Allowlist + amount gate for the allowance grant
├── injectSignature()             # Asserted signature-placeholder substitution
├── assertOrderResponse()         # Response shape validation
├── postWithRetry()               # Timeout + bounded jittered retry + idempotency
├── parseAmount()                 # Strict decimal amount parsing
├── getWalletBalances()           # Balance checking utility
├── executeTrade()                # Trade execution logic
└── main()                        # Interactive CLI loop
```

## Best Practices

1. **Environment Security**: Never commit `.env.local`; it holds a live private key.
2. **Least-privilege allowlist**: List only contract addresses you have independently verified.
3. **Dry run first**: Use `EXECUTE_TRADE_DRY_RUN=1` to validate configuration.
4. **Notional caps**: Keep `EXECUTE_TRADE_MAX_NOTIONAL` as low as your use case allows.
5. **Balance checks**: Monitor balances before and after trades.
6. **MEV Protection**: Always enable MEV protection for better execution.

## Troubleshooting

### Common Issues
- **`RPC URL not configured`**: Set the network-specific RPC URL in `.env.local`.
- **`No trusted contracts configured`**: Set `EXECUTE_TRADE_TRUSTED_CONTRACTS_<NETWORK>`.
- **`Invalid token address`**: Must be `0x` + 40 hexadecimal characters and pass checksum validation.
- **`Transaction failed`**: Check network connectivity and gas availability.
- **`Unauthorized`**: Verify the API token and its permissions.

## Support and Resources

- **API Documentation**: https://docs.o1.exchange/api/trading
- **Example Implementation**: `sampleScripts/execute-trade-interactive.js`
- **Repository**: https://github.com/o1exchange/o1-api

This skill provides a framework for integrating o1.exchange trading capabilities into
Claude Code workflows. It performs real transactions; verify the allowlist and the
notional cap before every use.
