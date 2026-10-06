# Security Policy

## Reporting a vulnerability

Please report security issues privately rather than opening a public issue.

- Email: security@o1.exchange
- Include: affected file or endpoint, reproduction steps, and the impact you observed.

We aim to acknowledge reports within 3 business days and to provide a remediation
timeline within 10 business days.

## Scope

This repository contains a sample trading client that loads a wallet private key and
broadcasts real transactions on the Base and BSC mainnets. Reports about the following
are in scope:

- missing or bypassable validation of server-supplied transaction payloads
- signing a transaction the operator did not authorise
- leakage of `EXECUTE_TRADE_PRIVATE_KEY` or `EXECUTE_TRADE_API_TOKEN`
- a path by which untrusted input reaches a signature, a shell, or an HTTP request
- weaknesses in the Permit2 allowance flow

Out of scope:

- third-party RPC endpoint compromise
- losses caused by an operator allowlisting a malicious contract in their own
  `.env.local`
- issues in the hosted o1.exchange API itself (report those to the address above)

## Handling secrets

`.env.local` holds a live private key. It is covered by `.gitignore`. If a private key
is ever committed, pushed, or pasted into a public channel, treat the wallet as
compromised and rotate the key immediately -- removing the file in a later commit does
not remove it from git history.
