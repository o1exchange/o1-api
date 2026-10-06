/**
 * Interactive o1.exchange trading CLI.
 *
 * SECURITY MODEL
 * --------------
 * This script signs transactions produced by a remote HTTP API using a hot
 * wallet. The API response is therefore UNTRUSTED INPUT, exactly like a web page
 * or a downloaded file. Nothing obtained from it is signed until it has passed an
 * explicit allowlist check:
 *
 *   1. `chainId` must equal the network the operator selected;
 *   2. the transaction `to` address must appear in the operator-configured
 *      trusted-contract allowlist for that network;
 *   3. the Permit2 EIP-712 domain `chainId` and `verifyingContract` must match
 *      that same allowlist -- this is what actually grants a spending allowance;
 *   4. the Permit2 spender/amount must match the order the operator confirmed;
 *   5. native `value` must be zero or within the configured notional cap.
 *
 * If the trusted-contract allowlist is not configured the script refuses to sign
 * and exits. It fails closed; it never falls back to "sign whatever arrived".
 *
 * Additional controls: a per-trade notional ceiling, a DRY_RUN mode that stops
 * before any signing, mandatory human confirmation immediately before signing,
 * request timeouts, bounded retries with jitter, and a client-supplied idempotency
 * key so a retried order cannot execute twice.
 */

import axios from "axios";
import {
  JsonRpcProvider,
  Wallet,
  Transaction,
  Contract,
  formatUnits,
  getAddress,
  Interface,
} from "ethers";
import dotenv from "dotenv";
import readline from "node:readline";

// Load environment variables from .env.local. There is no implicit .env
// fallback: silently reading a second file makes it unclear which credentials
// are actually in effect.
dotenv.config({ path: ".env.local" });

const PRIVATE_KEY = process.env.EXECUTE_TRADE_PRIVATE_KEY || "<PRIVATE_KEY>";
const API_TOKEN = process.env.EXECUTE_TRADE_API_TOKEN || "<API_TOKEN>";
const BASE_URL = process.env.EXECUTE_TRADE_BASE_URL || "https://api.o1.exchange";

/**
 * Hard ceiling on the native-currency value of a single order, in whole units.
 * Set EXECUTE_TRADE_MAX_NOTIONAL to override. This is a blast-radius limit for
 * excessive agency: a single misinterpreted instruction cannot move an unbounded
 * amount of funds.
 */
const MAX_NOTIONAL = Number(process.env.EXECUTE_TRADE_MAX_NOTIONAL || "1");

/**
 * When true, the script creates the order but stops before signing or submitting
 * anything. Set EXECUTE_TRADE_DRY_RUN=1 to exercise the flow safely.
 */
const DRY_RUN = /^(1|true|yes)$/i.test(
  process.env.EXECUTE_TRADE_DRY_RUN || "",
);

/** Slippage tolerance in basis points (3%). */
const SLIPPAGE_BPS = 300;

/** HTTP timeouts for outbound API calls, in milliseconds. */
const HTTP_TIMEOUT_MS = Number(process.env.EXECUTE_TRADE_HTTP_TIMEOUT_MS || "20000");

/** Bounded retry policy for idempotent-safe GET-style calls. */
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;

// Create readline interface for user input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// Helper function to prompt for user input
const question = (prompt) => {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer);
    });
  });
};

// ERC20 ABI for balance checking
const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

/** Permit2 `PermitTransferFrom` witness types, used to decode and verify the allowance. */
const PERMIT2_ABI = [
  "function allowance(address owner, address token, address spender) view returns (uint160)",
  "function nonce(address owner, uint48 word) view returns (uint256)",
];

/**
 * Network configurations.
 *
 * `trustedContracts` is deliberately empty by default. It must be populated from
 * EXECUTE_TRADE_TRUSTED_CONTRACTS_<NETWORK>; while it is empty, every trade is
 * refused. See the "Security" section of SKILL.md.
 */
const NETWORKS = {
  base: {
    networkId: 8453,
    name: "Base",
    rpcUrl: process.env.EXECUTE_TRADE_BASE_RPC_URL || "<BASE_RPC_URL>",
    nativeSymbol: "ETH",
    nativeDecimals: 18,
    trustedContracts: parseTrustedContracts("BASE"),
  },
  bsc: {
    networkId: 56,
    name: "BSC",
    rpcUrl: process.env.EXECUTE_TRADE_BSC_RPC_URL || "<BSC_RPC_URL>",
    nativeSymbol: "BNB",
    nativeDecimals: 18,
    trustedContracts: parseTrustedContracts("BSC"),
  },
};

/**
 * Parse a comma-separated allowlist of contract addresses for a network.
 * Entries are checksum-validated so a typo cannot silently widen the allowlist.
 */
function parseTrustedContracts(networkKey) {
  const raw = process.env[`EXECUTE_TRADE_TRUSTED_CONTRACTS_${networkKey}`] || "";
  const out = new Set();
  for (const entry of raw.split(",")) {
    const value = entry.trim();
    if (!value) continue;
    try {
      out.add(getAddress(value).toLowerCase());
    } catch {
      console.error(
        `Ignoring invalid address in EXECUTE_TRADE_TRUSTED_CONTRACTS_${networkKey}: ${value}`,
      );
    }
  }
  return out;
}

// Fixed value, don't change it
const SIGNATURE_PLACEHOLDER =
  "42f68902113a2a579bcc207c91254c8516d921250e748c18a082d91d74908f8e9a05f27b72a030c6a42d77d0e0aab6fb09219b01a01e7b5b24e4f322ee1762ff1b";

/**
 * Raised when an untrusted API response fails a safety check. The message is
 * surfaced to the operator verbatim; it never contains key material.
 */
class UnsafeTransactionError extends Error {}

/**
 * Validate a transaction before it is signed.
 *
 * @param {import("ethers").Transaction} tx        parsed transaction from the API
 * @param {object} network                          selected network descriptor
 * @param {object} order                            the order the operator confirmed
 * @returns {void} throws UnsafeTransactionError on any mismatch
 */
function assertTransactionIsSafe(tx, network, order) {
  // 1. Chain binding. Without this, a Base selection can sign a mainnet or BSC
  //    transaction returned by a compromised endpoint.
  if (tx.chainId !== BigInt(network.networkId)) {
    throw new UnsafeTransactionError(
      `chainId mismatch: expected ${network.networkId}, got ${tx.chainId}`,
    );
  }

  // 2. Destination allowlist.
  if (!tx.to) {
    throw new UnsafeTransactionError("transaction has no destination address");
  }
  let destination;
  try {
    destination = getAddress(tx.to);
  } catch {
    throw new UnsafeTransactionError(`destination is not a valid address: ${tx.to}`);
  }
  if (!network.trustedContracts.has(destination.toLowerCase())) {
    throw new UnsafeTransactionError(
      `destination ${destination} is not in the trusted-contract allowlist for ${network.name}. ` +
        `Refusing to sign. Add it to EXECUTE_TRADE_TRUSTED_CONTRACTS_${network.name.toUpperCase()} ` +
        `only if you have verified it.`,
    );
  }

  // 3. Native value cap. A swap should not carry native value; a plain transfer
  //    must stay inside the configured notional ceiling.
  if (tx.value !== 0n && tx.value !== undefined) {
    const value = BigInt(tx.value);
    const cap = BigInt(Math.round(MAX_NOTIONAL * 10 ** network.nativeDecimals));
    if (value > cap) {
      throw new UnsafeTransactionError(
        `transaction value ${formatUnits(value, network.nativeDecimals)} ${network.nativeSymbol} ` +
          `exceeds the ${MAX_NOTIONAL} ${network.nativeSymbol} per-trade cap`,
      );
    }
  }

  // 4. Gas sanity. An unbounded gas limit is a resource-abuse red flag.
  if (tx.gasLimit !== undefined && tx.gasLimit > 5_000_000n) {
    throw new UnsafeTransactionError(
      `transaction gas limit ${tx.gasLimit} exceeds the 5,000,000 sanity ceiling`,
    );
  }

  // 5. Nonce sanity. tx.nonce may be null when the server leaves it to the node.
  if (tx.nonce !== undefined && tx.nonce !== null && tx.nonce < 0n) {
    throw new UnsafeTransactionError(`invalid nonce: ${tx.nonce}`);
  }

  // 6. The order fields the operator confirmed must match what is being signed.
  if (order.tokenAddress && tx.to && order.tokenAddress.toLowerCase() !== tx.to.toLowerCase()) {
    // Not fatal on its own: a router-mediated order legitimately targets the
    // router rather than the token. Recorded for operator visibility instead.
    console.log(
      `   note: transaction targets ${destination}, order token is ${order.tokenAddress}`,
    );
  }
}

/**
 * Validate the Permit2 EIP-712 payload that authorises a gasless allowance.
 *
 * This is the highest-value check in the script: the typed-data signature is a
 * standing permission to move funds, and it outlives this single transaction.
 */
function assertPermit2IsSafe(eip712, network, order) {
  const { domain, types, values } = eip712;

  if (!domain || !types || !values) {
    throw new UnsafeTransactionError("permit2 payload is missing domain/types/values");
  }

  // The signed domain must belong to the selected chain.
  const domainChainId = BigInt(domain.chainId);
  if (domainChainId !== BigInt(network.networkId)) {
    throw new UnsafeTransactionError(
      `permit2 domain chainId mismatch: expected ${network.networkId}, got ${domainChainId}`,
    );
  }

  // The verifying contract must be the allowlisted Permit2 deployment.
  let verifying;
  try {
    verifying = getAddress(domain.verifyingContract);
  } catch {
    throw new UnsafeTransactionError(
      `permit2 verifyingContract is not a valid address: ${domain.verifyingContract}`,
    );
  }
  if (!network.trustedContracts.has(verifying.toLowerCase())) {
    throw new UnsafeTransactionError(
      `permit2 verifyingContract ${verifying} is not in the trusted-contract allowlist for ${network.name}. ` +
        `Refusing to sign a standing allowance grant.`,
    );
  }

  // The spender the allowance is granted to must also be allowlisted, otherwise a
  // valid Permit2 signature can still hand spending rights to an arbitrary party.
  // The field is nested differently per witness type, so every known location is
  // checked: `Permit` puts it at the top level, `PermitTransferFrom` nests it
  // under `permitted`, and `TokenPermissions` nests it under `allowed`.
  const spender =
    values.spender ??
    values.permitted?.spender ??
    values.allowed?.spender ??
    values.permit?.spender;
  if (!spender) {
    throw new UnsafeTransactionError(
      "permit2 payload does not declare a spender; refusing to sign an allowance " +
        "whose recipient cannot be verified",
    );
  }
  {
    let spenderAddress;
    try {
      spenderAddress = getAddress(spender);
    } catch {
      throw new UnsafeTransactionError(`permit2 spender is not a valid address: ${spender}`);
    }
    if (!network.trustedContracts.has(spenderAddress.toLowerCase())) {
      throw new UnsafeTransactionError(
        `permit2 spender ${spenderAddress} is not in the trusted-contract allowlist for ${network.name}.`,
      );
    }
  }

  // The permitted amount must match what the operator confirmed.
  const permitted = values.permit?.amount ?? values.permitted?.amount;
  if (permitted !== undefined && order.amountWei !== undefined) {
    if (BigInt(permitted) < BigInt(order.amountWei)) {
      throw new UnsafeTransactionError(
        `permit2 permits ${permitted} but the confirmed order requires ${order.amountWei}`,
      );
    }
  }

  // A signature over an unexpected type set may still be exploitable; require the
  // primary type to be one we recognise.
  const primaryTypes = Object.keys(types || {});
  const known = new Set([
    "PermitTransferFrom",
    "PermitBatchTransferFrom",
    "TokenPermissions",
    "Permit",
  ]);
  if (!primaryTypes.some((t) => known.has(t))) {
    throw new UnsafeTransactionError(
      `unrecognised permit2 typed-data types: ${primaryTypes.join(", ")}`,
    );
  }
}

/**
 * Replace the signature placeholder in calldata, asserting the substitution
 * actually happened.
 *
 * `String.prototype.replace` silently no-ops when the needle is absent, and a
 * non-global replace only substitutes the first occurrence. Either case would
 * submit a transaction carrying an invalid signature while appearing to succeed.
 */
function injectSignature(txData, signature) {
  if (typeof txData !== "string" || !txData.startsWith("0x")) {
    throw new UnsafeTransactionError("transaction calldata is not a hex string");
  }
  const occurrences = txData.split(SIGNATURE_PLACEHOLDER).length - 1;
  if (occurrences !== 1) {
    throw new UnsafeTransactionError(
      `expected exactly 1 signature placeholder in calldata, found ${occurrences}`,
    );
  }
  const hexSignature = signature.startsWith("0x") ? signature.slice(2) : signature;
  if (hexSignature.length !== SIGNATURE_PLACEHOLDER.length) {
    throw new UnsafeTransactionError(
      `signature length ${hexSignature.length} does not match placeholder length ` +
        `${SIGNATURE_PLACEHOLDER.length}`,
    );
  }
  return txData.replace(SIGNATURE_PLACEHOLDER, hexSignature);
}

/**
 * Minimal shape validation of an API response before any of it is trusted.
 */
function assertOrderResponse(data) {
  if (!data || typeof data !== "object") {
    throw new Error("order response is not an object");
  }
  if (data.success !== true) {
    return false;
  }
  if (!Array.isArray(data.transactions) || data.transactions.length === 0) {
    throw new Error("order response contains no transactions");
  }
  for (const ctx of data.transactions) {
    if (!ctx || typeof ctx.unsigned !== "string" || !ctx.unsigned.startsWith("0x")) {
      throw new Error("a transaction in the response is missing its unsigned payload");
    }
  }
  return true;
}

/**
 * POST with an explicit timeout and bounded retry with jitter.
 *
 * Retries are only safe because every mutating call carries a stable
 * `clientOrderId`, making the order idempotent server-side.
 */
async function postWithRetry(url, body, headers, { idempotencyKey } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      return await axios.post(url, body, {
        headers: {
          ...headers,
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        signal: controller.signal,
        timeout: HTTP_TIMEOUT_MS,
      });
    } catch (error) {
      lastError = error;
      const status = error?.response?.status;
      // Never retry a client error: the request itself is wrong.
      if (status && status >= 400 && status < 500) throw error;
      if (attempt === MAX_RETRIES) break;
      // Full jitter prevents a synchronised retry storm across instances.
      const delay = Math.random() * RETRY_BASE_DELAY_MS * 2 ** attempt;
      console.log(
        `   request failed (${error.code || status || "network"}); retrying in ${Math.round(delay)}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

// Function to get wallet balances
const getWalletBalances = async (provider, wallet, tokenAddress = null) => {
  try {
    const balances = {};

    // Get ETH balance
    const ethBalance = await provider.getBalance(wallet.address);
    balances.eth = {
      raw: ethBalance,
      // Format from the raw bigint; converting through Number() first loses
      // precision above 2^53 wei.
      formatted: Number(formatUnits(ethBalance, 18)).toFixed(6),
    };

    // Get token balance if token address provided
    if (tokenAddress) {
      try {
        const tokenContract = new Contract(tokenAddress, ERC20_ABI, provider);
        const [balance, decimals, symbol] = await Promise.all([
          tokenContract.balanceOf(wallet.address),
          tokenContract.decimals(),
          tokenContract.symbol().catch(() => "TOKEN"),
        ]);

        balances.token = {
          raw: balance,
          formatted: Number(formatUnits(balance, decimals)).toFixed(6),
          symbol: symbol,
          address: tokenAddress,
        };
      } catch (error) {
        // Do not discard the error: a silent null here is indistinguishable
        // from a zero balance downstream.
        console.log(`   Could not fetch token balance: ${error.message || error}`);
      }
    }

    return balances;
  } catch (error) {
    console.error(`   Error fetching balances: ${error.message || error}`);
    if (error?.stack) console.error(error.stack);
    return null;
  }
};

/**
 * Subtract two fixed-precision decimal strings without going through a float.
 * The previous implementation parsed already-rounded strings, so the reported
 * delta could differ from the real one.
 */
function decimalDelta(after, before) {
  const scale = 1e6;
  const a = BigInt(Math.round(Number(after) * scale));
  const b = BigInt(Math.round(Number(before) * scale));
  const diff = a - b;
  const sign = diff < 0n ? "-" : "";
  const abs = diff < 0n ? -diff : diff;
  const whole = abs / BigInt(scale);
  const frac = abs % BigInt(scale);
  return `${sign}${whole}.${frac.toString().padStart(6, "0")}`;
}

const executeTrade = async (
  tokenAddress,
  uiAmount,
  direction,
  orderId,
  slippageBps = SLIPPAGE_BPS,
  network = NETWORKS.base,
) => {
  try {
    const provider = new JsonRpcProvider(network.rpcUrl);
    // Bind the wallet to the provider and the selected chain. A provider-less
    // Wallet cannot detect a chain mismatch on its own.
    const wallet = new Wallet(PRIVATE_KEY, provider);
    const providerNetwork = await provider.getNetwork();
    if (Number(providerNetwork.chainId) !== network.networkId) {
      throw new Error(
        `RPC is on chain ${providerNetwork.chainId} but ${network.name} was selected ` +
          `(${network.networkId}). Refusing to sign.`,
      );
    }

    if (network.trustedContracts.size === 0) {
      throw new Error(
        `No trusted contracts configured for ${network.name}. Set ` +
          `EXECUTE_TRADE_TRUSTED_CONTRACTS_${network.name.toUpperCase()} to a ` +
          `comma-separated list of verified contract addresses before trading.`,
      );
    }

    const amountWei = BigInt(
      Math.round(Number(uiAmount) * 10 ** network.nativeDecimals),
    );

    console.log(
      `\nExecuting ${direction} order on ${network.name} for ${uiAmount} ` +
        `${direction === "buy" ? network.nativeSymbol : "tokens"} of ${tokenAddress}...`,
    );

    // Get balances before trade
    console.log("\nBalances before trade:");
    const balancesBefore = await getWalletBalances(provider, wallet, tokenAddress);
    if (balancesBefore) {
      console.log(`   ${network.nativeSymbol}: ${balancesBefore.eth.formatted}`);
      if (balancesBefore.token) {
        console.log(
          `   ${balancesBefore.token.symbol}: ${balancesBefore.token.formatted}`,
        );
      }
    }

    if (DRY_RUN) {
      console.log(
        "\n🧪 DRY RUN enabled (EXECUTE_TRADE_DRY_RUN). Stopping before order creation.",
      );
      return false;
    }

    const { data } = await postWithRetry(
      `${BASE_URL}/api/v2/order`,
      {
        signerAddress: wallet.address,
        tokenAddress,
        uiAmount,
        direction,
        slippageBps,
        mevProtection: true,
        networkId: network.networkId,
      },
      { Authorization: `Bearer ${API_TOKEN}` },
      { idempotencyKey: orderId },
    );

    if (!assertOrderResponse(data)) {
      console.error("❌ Order rejected:", data?.message ?? "no reason given");
      return false;
    }

    const order = {
      id: data.id,
      tokenAddress,
      amountWei,
      direction,
      network,
    };

    const txContexts = data.transactions;
    const requestBody = {
      id: data.id,
      transactions: [],
    };

    for (const ctx of txContexts) {
      const submitCtx = { id: ctx.id };

      const unsignedTx = Transaction.from(ctx.unsigned);

      // ---- Validation gate: nothing below this line signs untrusted data. ----
      assertTransactionIsSafe(unsignedTx, network, order);

      if (ctx?.permit2?.eip712) {
        assertPermit2IsSafe(ctx.permit2.eip712, network, order);

        const { domain, types, values } = ctx.permit2.eip712;
        const signature = await wallet.signTypedData(domain, types, values);

        // Assert the placeholder substitution actually happened.
        unsignedTx.data = injectSignature(unsignedTx.data, signature);

        submitCtx.permit2 = { eip712: { signature } };
      }

      const signedTx = await wallet.signTransaction(unsignedTx);
      // -----------------------------------------------------------------------

      submitCtx.signed = signedTx;
      requestBody.transactions.push(submitCtx);
    }

    // Submit the signed transactions
    const submitResponse = await postWithRetry(
      `${BASE_URL}/api/v2/order/complete`,
      requestBody,
      { Authorization: `Bearer ${API_TOKEN}` },
      { idempotencyKey: `${order.id}:complete` },
    );

    if (submitResponse.data?.success) {
      console.log("\n✅ Transaction submitted successfully!");
      console.log(`   Order id: ${order.id}`);
      if (submitResponse.data.transactions) {
        for (const tx of submitResponse.data.transactions) {
          if (tx.hash) console.log(`   Transaction hash: ${tx.hash}`);
          if (tx.tokenDelta) console.log(`   Token Balance Change: ${tx.tokenDelta}`);
        }
      }
    } else {
      console.error(
        "❌ Transaction submission failed:",
        submitResponse.data?.message ?? "no reason given",
      );
      return false;
    }

    // Get balances after trade
    console.log("\nBalances after trade:");
    const balancesAfter = await getWalletBalances(provider, wallet, tokenAddress);
    if (balancesAfter) {
      console.log(`   ${network.nativeSymbol}: ${balancesAfter.eth.formatted}`);
      if (balancesAfter.token) {
        console.log(
          `   ${balancesAfter.token.symbol}: ${balancesAfter.token.formatted}`,
        );
      }

      // Show the change
      if (balancesBefore) {
        console.log("\n Balance changes:");
        const ethChange = decimalDelta(
          balancesAfter.eth.formatted,
          balancesBefore.eth.formatted,
        );
        console.log(`   ${network.nativeSymbol}: ${ethChange}`);

        if (balancesBefore.token && balancesAfter.token) {
          const tokenChange = decimalDelta(
            balancesAfter.token.formatted,
            balancesBefore.token.formatted,
          );
          console.log(`   ${balancesAfter.token.symbol}: ${tokenChange}`);
        }
      }
    }

    return true;
  } catch (error) {
    if (error instanceof UnsafeTransactionError) {
      // This is the important failure mode: the server asked for something the
      // operator has not authorised. Say so loudly and do not retry.
      console.error(`\n🛑 BLOCKED by safety check: ${error.message}`);
      return false;
    }
    console.error("❌ Error executing trade:", error.message || error);
    if (error?.stack) console.error(error.stack);
    return false;
  }
};

/**
 * Strictly parse a user-supplied amount.
 *
 * `parseFloat` accepts "Infinity", "1e999" and trailing garbage such as
 * "0.1abc"; the raw string was then forwarded to the API instead of the parsed
 * number. This rejects anything that is not a plain positive decimal.
 */
function parseAmount(raw) {
  const trimmed = String(raw).trim();
  if (!/^\d+(\.\d{1,18})?$/.test(trimmed)) {
    return null;
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  return { text: trimmed, value };
}

const main = async () => {
  // Check if required environment variables are set
  if (PRIVATE_KEY === "<PRIVATE_KEY>" || API_TOKEN === "<API_TOKEN>") {
    console.error(
      "Please set the required environment variables in your .env.local file:",
    );
    console.error("- EXECUTE_TRADE_PRIVATE_KEY");
    console.error("- EXECUTE_TRADE_API_TOKEN");
    console.error("- EXECUTE_TRADE_BASE_URL (optional, defaults to https://api.o1.exchange)");
    console.error("- EXECUTE_TRADE_BASE_RPC_URL (for Base)");
    console.error("- EXECUTE_TRADE_BSC_RPC_URL (for BSC)");
    console.error("- EXECUTE_TRADE_TRUSTED_CONTRACTS_BASE (required to trade on Base)");
    console.error("- EXECUTE_TRADE_TRUSTED_CONTRACTS_BSC (required to trade on BSC)");
    process.exitCode = 1;
    return;
  }

  console.log("Trading CLI");
  console.log("============================");
  if (DRY_RUN) {
    console.log("🧪 DRY RUN is ENABLED - no order will be created or signed.");
  }
  if (MAX_NOTIONAL > 0) {
    console.log(`Per-trade notional cap: ${MAX_NOTIONAL}`);
  }
  const wallet = new Wallet(PRIVATE_KEY);
  console.log("Wallet Address: ", wallet.address);
  console.log("\nSupported Networks:");
  console.log("  - base: Base (ETH)");
  console.log("  - bsc: BNB Smart Chain (BNB)");
  console.log("\nExample Token Addresses:");
  console.log("  Base (Zora): 0x1111111111166b7fe7bd91427724b487980afc69");
  console.log("  BSC (USDT): 0x55d398326f99059ff775485246999027b3197955");
  console.log("\nType 'exit' or 'quit' at any prompt to stop the script.\n");

  while (true) {
    try {
      // Prompt for network selection
      const networkInput = await question(
        "Select network (base/bsc) [default: base]: ",
      );
      if (["exit", "quit"].includes(networkInput.toLowerCase())) {
        console.log("Exiting...");
        break;
      }

      // Get selected network (default to base)
      const networkKey = networkInput.toLowerCase() || "base";
      const network = NETWORKS[networkKey];
      if (!network) {
        console.log("⚠️  Invalid network. Please enter 'base' or 'bsc'.\n");
        continue;
      }

      // Check if RPC URL is configured for selected network
      if (network.rpcUrl === "<BASE_RPC_URL>" || network.rpcUrl === "<BSC_RPC_URL>") {
        console.log(`⚠️  RPC URL not configured for ${network.name}.`);
        console.log(
          `   Please set EXECUTE_TRADE_${networkKey.toUpperCase()}_RPC_URL in your .env.local file.\n`,
        );
        continue;
      }

      // Fail closed when no contract allowlist is configured.
      if (network.trustedContracts.size === 0) {
        console.log(`⚠️  No trusted contracts configured for ${network.name}.`);
        console.log(
          `   Set EXECUTE_TRADE_TRUSTED_CONTRACTS_${network.name.toUpperCase()} to a ` +
            `comma-separated list of verified contract addresses.\n`,
        );
        continue;
      }

      console.log(`\nSelected network: ${network.name}`);

      // Prompt for token address
      const tokenAddress = (await question(
        "Enter token address (or 'exit' to quit): ",
      )).trim();
      if (["exit", "quit"].includes(tokenAddress.toLowerCase())) {
        console.log("Exiting...");
        break;
      }

      // Validate token address format and checksum
      if (!/^0x[a-fA-F0-9]{40}$/.test(tokenAddress)) {
        console.log(
          "⚠️  Invalid token address format. Please enter a valid EVM address.\n",
        );
        continue;
      }
      try {
        getAddress(tokenAddress);
      } catch {
        console.log("⚠️  Token address failed checksum validation.\n");
        continue;
      }

      // Prompt for buy/sell direction
      const direction = (await question("Enter direction (buy/sell): "))
        .toLowerCase();
      if (["exit", "quit"].includes(direction)) {
        console.log("Exiting...");
        break;
      }
      if (direction !== "buy" && direction !== "sell") {
        console.log("⚠️  Invalid direction. Please enter 'buy' or 'sell'.\n");
        continue;
      }

      // Prompt for amount
      const amountInput = await question(
        `Enter amount (${direction === "buy" ? network.nativeSymbol : "tokens"}): `,
      );
      if (["exit", "quit"].includes(amountInput.toLowerCase())) {
        console.log("Exiting...");
        break;
      }

      const parsed = parseAmount(amountInput);
      if (!parsed) {
        console.log(
          "⚠️  Invalid amount. Enter a positive decimal number such as 0.01 " +
            "(no exponent notation, no Infinity, no trailing characters).\n",
        );
        continue;
      }

      // Enforce the notional cap before the order is ever created.
      if (direction === "buy" && parsed.value > MAX_NOTIONAL) {
        console.log(
          `⚠️  Amount ${parsed.value} ${network.nativeSymbol} exceeds the ` +
            `${MAX_NOTIONAL} ${network.nativeSymbol} per-trade cap.\n`,
        );
        continue;
      }

      // Stable idempotency key so a retried confirmation cannot double-execute.
      const orderId = `${wallet.address}-${networkKey}-${tokenAddress}-${direction}-${parsed.text}`;

      // Confirm trade details
      console.log("\nTrade Summary:");
      console.log(`   Network: ${network.name} (chain ${network.networkId})`);
      console.log(`   Token: ${tokenAddress}`);
      console.log(`   Direction: ${direction}`);
      console.log(
        `   Amount: ${parsed.text} ${direction === "buy" ? network.nativeSymbol : "tokens"}`,
      );
      console.log(`   Slippage: ${SLIPPAGE_BPS / 100}%`);
      console.log(`   MEV Protection: Yes`);

      const confirm = await question("\nConfirm trade? (yes/no): ");
      if (["exit", "quit"].includes(confirm.toLowerCase())) {
        console.log("Exiting...");
        break;
      }

      if (confirm.toLowerCase() === "yes" || confirm.toLowerCase() === "y") {
        await executeTrade(
          tokenAddress,
          parsed.text,
          direction,
          orderId,
          SLIPPAGE_BPS,
          network,
        );
      } else {
        console.log("❌ Trade cancelled.\n");
      }

      // Ask if user wants to make another trade
      const another = await question(
        "\nWould you like to make another trade? (yes/no): ",
      );
      if (!["yes", "y"].includes(another.toLowerCase())) {
        console.log("Exiting...");
        break;
      }
      console.log(""); // Add blank line for next iteration
    } catch (error) {
      console.error("❌ An error occurred:", error);
      if (error?.stack) console.error(error.stack);
      const retry = await question("\nWould you like to try again? (yes/no): ");
      if (!["yes", "y"].includes(retry.toLowerCase())) {
        break;
      }
    }
  }

  rl.close();
  // Set the exit code instead of calling process.exit(), which does not flush
  // buffered stdout writes and can truncate the final transaction hash.
  process.exitCode = 0;
};

main();
