# o1-api

An HTTP interface to o1.exchange trading, liquidity, and tooling.

> **Warning: the sample script signs real transactions with a hot wallet.** It loads a
> private key from `.env.local` and broadcasts irreversible, value-moving transactions
> on the Base and BSC mainnets. Read the [Security](SKILL.md#security) section and
> configure the trusted-contract allowlist before running it.

## Install

```bash
npm ci
```

Requires Node.js `>= 20.19`.

## Configure

Create `.env.local` in this directory. It is git-ignored and must never be committed.

```env
EXECUTE_TRADE_PRIVATE_KEY=your_wallet_private_key_here
EXECUTE_TRADE_API_TOKEN=your_o1_exchange_api_token_here
EXECUTE_TRADE_BASE_URL=https://api.o1.exchange
EXECUTE_TRADE_BASE_RPC_URL=your_base_rpc_url_here
EXECUTE_TRADE_BSC_RPC_URL=your_bsc_rpc_url_here
EXECUTE_TRADE_TRUSTED_CONTRACTS_BASE=0x...,0x...
EXECUTE_TRADE_TRUSTED_CONTRACTS_BSC=0x...,0x...
```

## Run

```bash
npm start
```

Validate configuration without creating or signing anything:

```bash
EXECUTE_TRADE_DRY_RUN=1 npm start
```

## Safety model

The trading API returns transaction payloads that a client must sign. Those payloads
are treated as untrusted input: every transaction is checked against an
operator-configured contract allowlist, and the Permit2 allowance grant is validated
separately. If the allowlist is unset, the script refuses to trade.

See [SKILL.md](SKILL.md#security) for the full list of checks.

## Networks

| Network | Chain ID | Native currency |
|---|---|---|
| Base | 8453 | ETH |
| BSC | 56 | BNB |

## License

MIT — see [LICENSE](LICENSE).
