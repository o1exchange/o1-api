# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is an HTTP interface to o1.exchange trading, liquidity, and tooling. The project provides a sample script for interacting with the o1.exchange API to execute trades on the Base and BSC networks.

> **Warning: this project signs real transactions with a hot wallet.**
> `sampleScripts/execute-trade-interactive.js` loads a private key from `.env.local`
> and broadcasts irreversible, value-moving transactions on mainnet. Do not run it
> against a live key without reading the Security section of `SKILL.md` and
> configuring the trusted-contract allowlist.

## Architecture

### Core Components

- **`sampleScripts/execute-trade-interactive.js`**: The only executable. Interactive trading CLI covering Base and BSC via the o1.exchange API.

### Security Architecture

The API response is treated as **untrusted input**. A validation gate runs before any
signature is produced:

| Function | Purpose |
|---|---|
| `assertOrderResponse()` | Shape validation of the order response |
| `assertTransactionIsSafe()` | chainId binding, destination allowlist, native-value cap, gas and nonce sanity |
| `assertPermit2IsSafe()` | Permit2 domain, verifying contract, spender, permitted amount, recognised type set |
| `injectSignature()` | Asserts the signature placeholder appears exactly once before substituting |

All four throw `UnsafeTransactionError`, which aborts the trade without signing.

The allowlist comes from `EXECUTE_TRADE_TRUSTED_CONTRACTS_BASE` / `_BSC`. When it is
unset the script refuses to trade. There is no permissive default.

### Key Dependencies

ES modules; requires Node.js `>= 20.19`.

- `axios` — HTTP API calls to o1.exchange
- `ethers` — EVM wallet management, transaction and EIP-712 typed-data signing
- `dotenv` — environment variable management
- `node:readline` — Node.js **built-in**; not an npm package

## Environment Configuration

Required, in `.env.local` (git-ignored; never commit):

- `EXECUTE_TRADE_PRIVATE_KEY` — wallet private key for signing transactions
- `EXECUTE_TRADE_API_TOKEN` — o1.exchange API authentication token
- `EXECUTE_TRADE_TRUSTED_CONTRACTS_BASE` — comma-separated allowlisted contracts (required to trade on Base)
- `EXECUTE_TRADE_TRUSTED_CONTRACTS_BSC` — comma-separated allowlisted contracts (required to trade on BSC)

Optional:

- `EXECUTE_TRADE_BASE_URL` — API base URL (defaults to `https://api.o1.exchange`)
- `EXECUTE_TRADE_BASE_RPC_URL` — Base network RPC endpoint
- `EXECUTE_TRADE_BSC_RPC_URL` — BSC network RPC endpoint
- `EXECUTE_TRADE_MAX_NOTIONAL` — per-trade native-currency ceiling (default `1`)
- `EXECUTE_TRADE_DRY_RUN` — set to `1` to stop before order creation
- `EXECUTE_TRADE_HTTP_TIMEOUT_MS` — outbound request timeout (default `20000`)

## Running the Project

```bash
npm ci        # install the pinned dependency tree
npm start     # run the interactive CLI
npm run check # syntax-check the script
```

Dry run, which creates and signs nothing:

```bash
EXECUTE_TRADE_DRY_RUN=1 npm start
```

The interactive CLI prompts for:
1. Network selection (Base or BSC)
2. Token address
3. Trade direction (buy/sell)
4. Amount (plain positive decimal only)
5. Trade confirmation

## Network Support

- **Base** (Chain ID 8453), native currency ETH
- **BSC** (Chain ID 56), native currency BNB

Both use MEV protection and a fixed 3% (300 bps) slippage tolerance. Solana is not
supported.

## Trading Implementation Details

- o1.exchange API v2 endpoints for order creation and completion
- EIP-712 typed-data signing for Permit2 gasless approvals
- Signature placeholder replacement with an explicit occurrence-count assertion
- Pre/post trade balance checks, with delta computed on `bigint` rather than floats
- Amount parsing rejects exponent notation, `Infinity` and trailing characters
- Outbound requests use a timeout plus bounded retries with jitter
- Mutating requests send an `Idempotency-Key` header so retries cannot double-execute
