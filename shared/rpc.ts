import { createPublicClient, custom, type Hex } from "viem";
import { verifyCode } from "./code";
import { json, type Settings } from "./config";

const allowed = new Set(["eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getCode", "eth_getLogs", "eth_call", "eth_getTransactionReceipt", "eth_getTransactionByHash", "web3_clientVersion"]);
export function readTransport(s: Pick<Settings, "rpcUrl" | "timeout">) {
  return custom({
    async request({ method, params }) {
      if (!allowed.has(method)) throw new Error(`RPC method is not read-only: ${method}`);
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await fetch(s.rpcUrl, { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? [] }), signal: AbortSignal.timeout(s.timeout) });
          if ((res.status === 429 || res.status === 503) && attempt < 2) { await new Promise(r => setTimeout(r, 200 * 2 ** attempt)); continue; }
          if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
          const body = await res.json() as any;
          if (body.error) throw new Error(`RPC ${method}: ${body.error.code} ${body.error.message}`);
          if (body.jsonrpc !== "2.0" || body.id !== 1 || !("result" in body)) throw new Error("Malformed RPC response");
          if ((method === "eth_getCode" || method === "eth_call") && (typeof body.result !== "string" || !/^0x(?:[0-9a-f]{2})*$/i.test(body.result))) throw new Error("Malformed RPC hex data; unavailable history cannot be treated as empty code");
          if (method === "eth_getLogs") {
            if (!Array.isArray(body.result)) throw new Error("Malformed RPC logs");
            const unique = new Map<string, any>();
            for (const log of body.result) {
              const key = `${log.blockNumber}:${log.logIndex}`;
              const previous = unique.get(key);
              if (previous && json(previous) !== json(log)) throw new Error("Conflicting duplicate RPC log");
              unique.set(key, log);
            }
            return [...unique.values()];
          }
          return body.result;
        } catch (error) { throw error; }
      }
      throw new Error("RPC retries exhausted");
    },
  }, { retryCount: 0 });
}
export function rpcClient(s: Pick<Settings, "rpcUrl" | "timeout">) {
  return createPublicClient({ cacheTime: 0, transport: readTransport(s) });
}
export type ReadClient = ReturnType<typeof rpcClient>;
export const hashPattern = /^0x[0-9a-f]{64}$/i;
export async function verifyIdentity(client: ReadClient, s: Settings, blockNumber: bigint) {
  if (await client.getChainId() !== s.chainId) throw new Error("RPC chain identity mismatch");
  for (const [name, address, start] of [["token", s.token, s.tokenStart], ["escrow", s.escrow, s.escrowStart]] as const) {
    if (blockNumber < BigInt(start)) throw new Error("Checkpoint precedes deployment");
    if (start > 0) {
      const prior = await client.getCode({ address, blockNumber: BigInt(start - 1) });
      if (prior && prior !== "0x") throw new Error(`${name}: configured start omits deployment history`);
    }
    const code = await client.getCode({ address, blockNumber });
    if (!code || code === "0x") throw new Error(`${name}: deployed code unavailable`);
    verifyCode(name === "token" ? "MockPaymentToken" : "RentalEscrow", code, s.token);
  }
}
// Consecutive finite ranges, adaptive shrinking, explicit boundaries; no latest fallback.
export async function scanLogs(client: ReadClient, address: Hex, start: bigint, end: bigint, maxRange: number) {
  if (start > end) throw new Error("Invalid log boundary");
  const result = [];
  for (let from = start; from <= end;) {
    let span = BigInt(maxRange);
    for (;;) {
      const to = from + span - 1n < end ? from + span - 1n : end;
      try {
        const logs = await client.getLogs({ address, fromBlock: from, toBlock: to });
        // A full provider page is suspect; retry in smaller ranges.
        if (logs.length >= 1000) throw new Error("Possible truncated log page");
        for (const log of logs) {
          if (log.blockNumber === null || log.blockNumber < from || log.blockNumber > to || log.address.toLowerCase() !== address.toLowerCase() || log.removed ||
            !hashPattern.test(log.blockHash ?? "") || !hashPattern.test(log.transactionHash ?? "") ||
            !Number.isSafeInteger(log.logIndex) || log.logIndex! < 0 || !Number.isSafeInteger(log.transactionIndex) || log.transactionIndex! < 0) throw new Error("Bad RPC log evidence");
        }
        result.push(...logs); from = to + 1n; break;
      } catch (error) {
        if (span === 1n) throw error;
        span = span / 2n || 1n;
      }
    }
  }
  result.sort((a, b) => a.blockNumber! < b.blockNumber! ? -1 : a.blockNumber! > b.blockNumber! ? 1 : a.logIndex! - b.logIndex!);
  const unique = new Map<string, typeof result[number]>();
  for (const log of result) {
    const key = `${log.blockNumber}:${log.logIndex}`;
    const prev = unique.get(key);
    if (prev) {
      if (JSON.stringify(prev, (_, v) => typeof v === "bigint" ? v.toString() : v) !== JSON.stringify(log, (_, v) => typeof v === "bigint" ? v.toString() : v)) throw new Error("Conflicting duplicate RPC log");
    } else unique.set(key, log);
  }
  return [...unique.values()];
}
