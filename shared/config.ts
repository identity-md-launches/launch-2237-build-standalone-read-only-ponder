import { getAddress, type Address } from "viem";

function integer(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name}`);
  return value;
}
export const chainId = integer("CHAIN_ID", 46630);
if (![46630, 31337].includes(chainId)) throw new Error("Only Robinhood trial or disposable Anvil 31337 supported");
function address(name: string, fallback: string): Address {
  const value = process.env[name] ?? (chainId === 46630 ? fallback : "");
  if (!value || /^0x0{40}$/i.test(value)) throw new Error(`Set ${name} to actual deployment`);
  return getAddress(value);
}
export const settings = {
  chainId,
  rpcUrl: process.env[`PONDER_RPC_URL_${chainId}`] ?? (chainId === 46630 ? "https://rpc.testnet.chain.robinhood.com" : "http://127.0.0.1:8545"),
  stateRpcUrl: process.env.RECONCILE_STATE_RPC_URL || undefined,
  ws: process.env[`PONDER_WS_URL_${chainId}`] || undefined,
  token: address("TOKEN_ADDRESS", "0x31339619db548257cE09A76f189b0b1932f5c0cd"),
  escrow: address("ESCROW_ADDRESS", "0x06135FF9311eCa80a7484444A552f28fFC660F05"),
  tokenStart: integer("TOKEN_START_BLOCK", 138710650),
  escrowStart: integer("ESCROW_START_BLOCK", 138710790),
  endBlock: process.env.END_BLOCK ? integer("END_BLOCK", 0) : undefined,
  checkpointInterval: integer("CHECKPOINT_INTERVAL", 100),
  logRange: integer("RPC_LOG_RANGE", 500),
  timeout: integer("RPC_TIMEOUT_MS", 15000),
  reorgWindow: integer("REORG_WINDOW_SECONDS", 180),
};
if (settings.checkpointInterval < 1 || settings.checkpointInterval > 100) throw new Error("CHECKPOINT_INTERVAL must be 1..100");
if (settings.logRange < 1 || settings.logRange > 1000 || settings.timeout < 100 || settings.timeout > 60000) throw new Error("RPC bounds invalid");
if (chainId === 31337) {
  const url = new URL(settings.rpcUrl);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)) throw new Error("Anvil requires HTTP loopback RPC");
  if (settings.stateRpcUrl) {
    const state = new URL(settings.stateRpcUrl);
    if (state.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(state.hostname)) throw new Error("Local state RPC must be loopback");
  }
  if (settings.ws) {
    const ws = new URL(settings.ws);
    if (ws.protocol !== "ws:" || !["127.0.0.1", "[::1]", "localhost"].includes(ws.hostname)) throw new Error("Local websocket must be loopback");
  }
  if (!process.env.TOKEN_START_BLOCK || !process.env.ESCROW_START_BLOCK) throw new Error("Set real local receipt start blocks");
}
export type Settings = typeof settings;
export const json = (value: unknown) => JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
