import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createServer as netServer } from "node:net";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, writeFile, symlink } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, keccak256, toHex, type Address, type Hex } from "viem";
import { foundry } from "viem/chains";
import { RentalEscrowAbi } from "../abis/RentalEscrow";
import { MockPaymentTokenAbi } from "../abis/MockPaymentToken";
import type { Snapshot } from "../shared/snapshot";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = path.join(root, "test/scratch");
await mkdir(scratch, { recursive: true });
const work = await mkdtemp(path.join(scratch, "integration-"));
const owned: ChildProcess[] = [];
let proxy: Server | undefined;
const checks: string[] = [];
const canonical = (d: Snapshot) => Object.fromEntries(Object.entries(d.tables).map(([name, rows]) => [name, [...rows].sort((a,b) => String(a.id).localeCompare(String(b.id)))]));
const evidence: any = { database: process.env.TEST_DATABASE_URL ? "PostgreSQL" : "persistent PGlite", checks, logDirectory: path.basename(work) };
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T>, predicate: (result: T) => boolean, label: string, timeout = 60000): Promise<T> {
  const end = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < end) {
    try { const value = await fn(); if (predicate(value)) return value; last = value; } catch (e) { last = e; }
    await delay(200);
  }
  throw new Error(`Timed out: ${label}; last=${String(last)}`);
}
async function freePort() {
  const server = netServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as any).port as number;
  await new Promise<void>(r => server.close(() => r())); return port;
}
function launch(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, log: string) {
  const output = createWriteStream(path.join(work, log), { flags: "a" });
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.pipe(output); child.stderr!.pipe(output); owned.push(child);
  child.on("error", e => output.write(String(e)));
  return child;
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), delay(10000)]);
  if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await once(child, "exit"); }
}
async function cleanup() {
  for (const child of [...owned].reverse()) await stop(child);
  if (proxy) {
    const server = proxy; proxy = undefined;
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
  }
}
process.once("SIGINT", () => { void cleanup().finally(() => process.exit(130)); });
process.once("SIGTERM", () => { void cleanup().finally(() => process.exit(143)); });
function requireLoopback(endpoint: string) {
  const u = new URL(endpoint);
  if (u.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(u.hostname)) throw new Error("Fixture rejects nonlocal endpoint");
}
try {
  const anvilPort = await freePort(), proxyPort = await freePort(), apiPort = await freePort();
  const url = `http://127.0.0.1:${anvilPort}`; requireLoopback(url);
  launch("anvil", ["--host", "127.0.0.1", "--port", String(anvilPort), "--chain-id", "31337", "--silent"], work, process.env, "anvil.log");
  const publicClient = createPublicClient({ chain: foundry, transport: http(url, { retryCount: 0, timeout: 2000 }), cacheTime: 0 });
  await until(() => publicClient.getChainId(), id => id === 31337, "Anvil 31337 startup");
  const control = async (method: string, params: unknown[] = []) => {
    requireLoopback(url);
    if (await publicClient.getChainId() !== 31337) throw new Error("Fixture rejects other chain IDs");
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(3000) });
    const body = await res.json() as any; if (body.error) throw new Error(JSON.stringify(body.error)); return body.result;
  };
  const accounts: Address[] = await control("eth_accounts");
  const [admin, renter, staff, revoked, nextAdmin] = accounts;
  // No private keys. Only this newly spawned Anvil's unlocked accounts can transact.
  const wallet = (account: Address) => createWalletClient({ account, chain: foundry, transport: http(url, { retryCount: 0 }) });
  async function receipt(hash: Hex) { return publicClient.waitForTransactionReceipt({ hash, pollingInterval: 50 }); }
  async function write(account: Address, address: Address, abi: any, functionName: string, args: any[] = []) {
    requireLoopback(url); assert.equal(await publicClient.getChainId(), 31337);
    const result = await receipt(await wallet(account).writeContract({ address, abi, functionName, args }));
    assert.equal(result.status, "success", `${functionName} receipt`); return result;
  }
  const tokenFixture = JSON.parse(await readFile(path.join(root, "tests/fixtures/MockPaymentToken.json"), "utf8"));
  const escrowFixture = JSON.parse(await readFile(path.join(root, "tests/fixtures/RentalEscrow.json"), "utf8"));
  const tokenReceipt = await receipt(await wallet(admin).deployContract({ abi: tokenFixture.abi, bytecode: tokenFixture.bytecode, args: [admin] }));
  const token = tokenReceipt.contractAddress!;
  const escrowReceipt = await receipt(await wallet(admin).deployContract({ abi: escrowFixture.abi, bytecode: escrowFixture.bytecode, args: [token, admin] }));
  const escrow = escrowReceipt.contractAddress!;
  const tw = (actor: Address, name: string, args: any[]) => write(actor, token, MockPaymentTokenAbi, name, args);
  const ew = (actor: Address, name: string, args: any[]) => write(actor, escrow, RentalEscrowAbi, name, args);
  const ref = (name: string) => keccak256(toHex(name));
  await tw(admin, "transfer", [renter, 500000000n]);
  await ew(admin, "setStaff", [staff, true]); await ew(admin, "setStaff", [revoked, true]); await ew(admin, "setStaff", [revoked, false]);
  await ew(admin, "createPolicy", [50000000n, 5000000n, 3600n]); await ew(admin, "addItem", [1n, "ipfs://original"]);
  await tw(renter, "approve", [escrow, 500000000n]);
  await ew(renter, "reserve", [1n, 1n, ref("return")]);
  await ew(admin, "createPolicy", [75000000n, 7000000n, 7200n]); await ew(admin, "setItemPolicy", [1n, 2n]);
  await ew(admin, "setItemMetadata", [1n, "ipfs://updated"]); await ew(admin, "setItemListed", [1n, false]); await ew(admin, "setItemListed", [1n, true]);
  await ew(staff, "checkOut", [1n]); await ew(staff, "confirmReturn", [1n]); await ew(renter, "withdrawRefund", []);
  await ew(renter, "reserve", [1n, 2n, ref("cancel")]); await ew(renter, "cancel", [2n]); await ew(renter, "withdrawRefund", []);
  await ew(admin, "withdrawFees", [ref("fee-cancel"), admin, 7000000n]);
  await ew(renter, "reserve", [1n, 2n, ref("expire")]); await control("evm_increaseTime", [7201]); await control("evm_mine");
  await ew(nextAdmin, "expire", [3n]); await ew(renter, "withdrawRefund", []); await ew(admin, "withdrawFees", [ref("fee-expire"), admin, 7000000n]);
  await tw(admin, "transfer", [escrow, 123n]);
  await ew(admin, "transferAdmin", [nextAdmin]); await ew(nextAdmin, "acceptAdmin", []);
  // Query a real revert: revoked staff cannot check out a fresh reservation.
  await ew(renter, "reserve", [1n, 2n, ref("pending")]);
  await assert.rejects(publicClient.simulateContract({ account: revoked, address: escrow, abi: RentalEscrowAbi, functionName: "checkOut", args: [4n] }));
  checks.push("Anvil lifecycle transactions, immutable accepted terms, roles/revocation, cancellation, expiry, return, refunds/fees and donation");
  let outage = false, duplicate = true;
  const readMethods = new Set(["eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getLogs", "eth_getCode", "eth_call", "eth_getTransactionReceipt", "web3_clientVersion", "eth_getTransactionByHash"]);
  proxy = createServer(async (req, res) => {
    try {
      if (outage) { res.writeHead(503); res.end("owned fixture outage"); return; }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const requests = Array.isArray(body) ? body : [body];
      if (requests.some(r => !readMethods.has(r.method))) { res.writeHead(403); res.end("read-only indexer fixture proxy"); return; }
      const upstream = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const response = await upstream.json() as any;
      if (duplicate) for (const r of Array.isArray(response) ? response : [response]) {
        const method = requests.find(q => q.id === r.id)?.method;
        if (method === "eth_getLogs" && Array.isArray(r.result)) r.result = r.result.flatMap((l: any) => [l, { ...l }]);
      }
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify(response));
    } catch (e) { res.writeHead(502); res.end(String(e)); }
  });
  proxy.listen(proxyPort, "127.0.0.1"); await once(proxy, "listening");
  const sourceDir = path.join(work, "project"); await mkdir(sourceDir);
  for (const name of ["abis", "shared", "src", "ponder.config.ts", "ponder.schema.ts", "ponder-env.d.ts", "tsconfig.json", "package.json"]) await cp(path.join(root, name), path.join(sourceDir, name), { recursive: true });
  await symlink(path.join(root, "node_modules"), path.join(sourceDir, "node_modules"), "dir");
  const nonce = path.basename(work).replace(/[^a-z0-9]/gi, "").toLowerCase();
  const schemaName = `imd_${nonce}`;
  const testDb = process.env.TEST_DATABASE_URL;
  if (testDb) {
    const db = new URL(testDb);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(db.hostname)) throw new Error("Integration DB must be local and disposable");
  }
  const env = { ...process.env, NODE_ENV: "test", CHAIN_ID: "31337", PONDER_RPC_URL_31337: `http://127.0.0.1:${proxyPort}`, TOKEN_ADDRESS: token, ESCROW_ADDRESS: escrow,
    TOKEN_START_BLOCK: String(tokenReceipt.blockNumber), ESCROW_START_BLOCK: String(escrowReceipt.blockNumber), CHECKPOINT_INTERVAL: "1", RPC_LOG_RANGE: "20", RPC_TIMEOUT_MS: "1000", PORT: String(apiPort),
    RECONCILE_STATE_RPC_URL: "", PGLITE_DIRECTORY: ".ponder/pglite", PONDER_WS_URL_31337: "", DATABASE_URL: testDb ?? "", DATABASE_PRIVATE_URL: "", END_BLOCK: "" };
  const bin = path.join(root, "node_modules/ponder/dist/esm/bin/ponder.js");
  const start = (schema = schemaName, dir = sourceDir) => launch(process.execPath, [bin, "start", "--schema", schema, "--hostname", "127.0.0.1"], dir, env, `${schema}.log`);
  let indexer = start();
  const base = `http://127.0.0.1:${apiPort}`;
  const snapshot = async () => { const r = await fetch(`${base}/snapshot`, { signal: AbortSignal.timeout(2000) }); if (!r.ok) throw new Error(await r.text()); return await r.json() as Snapshot; };
  async function caughtUp() {
    const target = await publicClient.getBlockNumber();
    await until(snapshot, d => BigInt(d.tables.checkpoint[0]?.blockNumber ?? "0") >= target, "indexer caught up");
    await until(async () => (await fetch(`${base}/ready`)).status, status => status === 200, "/ready");
    await until(async () => await fetch(`${base}/sync`).then(r => r.json()) as any, status => status.rpcError === null, "RPC observation recovered");
    return snapshot();
  }
  let snap = await caughtUp();
  assert.equal(snap.tables.reservation.length, 4);
  assert.equal(snap.tables.reservation.find(r => r.id === "1")!.deposit, "50000000");
  assert.equal(snap.tables.reservation.find(r => r.id === "1")!.reservationWindow, "3600");
  assert.equal(snap.tables.reservation.find(r => r.id === "1")!.status, "5");
  assert.equal(snap.tables.reservation.find(r => r.id === "2")!.status, "3");
  assert.equal(snap.tables.reservation.find(r => r.id === "3")!.status, "4");
  assert.equal(snap.tables.staff.find(r => r.id === revoked.toLowerCase())!.enabled, "false");
  assert.equal(snap.tables.accounting[0].refundsPaid, "186000000");
  assert.equal(snap.tables.accounting[0].feesPaid, "14000000");
  assert.equal(snap.tables.accounting[0].tokenBalance, "75000123");
  assert.equal(snap.tables.feeRequest.length, 2);
  const graph = await fetch(`${base}/graphql`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: '{ reservations(limit: 10) { items { id status deposit } } }' }) }).then(r => r.json()) as any;
  assert.equal(graph.errors, undefined); assert.equal(graph.data.reservations.items.length, 4);
  checks.push("ordinary Ponder replay with duplicate RPC logs; GraphQL entity query and /ready");
  const snapshotPath = path.join(work, "snapshot.json"); await writeFile(snapshotPath, JSON.stringify(snap));
  // Execute the shipped read-only reconciliation CLI using the same block and actual Anvil storage.
  async function reconcileSnapshot(data: Snapshot, expectSuccess: boolean, label: string) {
    const f = path.join(work, `${label}.json`); await writeFile(f, JSON.stringify(data));
    const p = launch(process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), path.join(root, "scripts/reconcile.ts"), f], root, env, `reconcile-${label}.log`);
    const [code] = await once(p, "exit"); assert.equal(code === 0, expectSuccess, label);
  }
  await reconcileSnapshot(snap, true, "valid");
  for (const corruption of ["missingFee", "extraFee", "missingStaff", "extraStaff", "refundsPaid", "feesPaid", "acceptedTerms", "credit", "liabilities", "tokenBalance"] as const) {
    const broken = structuredClone(snap);
    if (corruption === "missingFee") broken.tables.feeRequest.pop();
    if (corruption === "extraFee") broken.tables.feeRequest.push({ ...broken.tables.feeRequest[0], id: ref("extra") });
    if (corruption === "missingStaff") broken.tables.staff = broken.tables.staff.filter(r => r.id !== revoked.toLowerCase());
    if (corruption === "extraStaff") broken.tables.staff.push({ id: accounts[6], enabled: "false" });
    if (corruption === "refundsPaid") broken.tables.accounting[0].refundsPaid = "0";
    if (corruption === "feesPaid") broken.tables.accounting[0].feesPaid = "0";
    if (corruption === "acceptedTerms") broken.tables.reservation[0].deposit = "1";
    if (corruption === "credit") broken.tables.renter[0].credit = "1";
    if (corruption === "liabilities") broken.tables.accounting[0].liabilities = "1";
    if (corruption === "tokenBalance") broken.tables.accounting[0].tokenBalance = "1";
    await reconcileSnapshot(broken, false, corruption);
  }
  checks.push("real CLI valid reconciliation plus missing/extra fee and staff (including revoked staff), altered historical payments/accepted terms/credits/liabilities/token balance rejection");
  const beforeRestart = JSON.stringify(canonical(snap));
  await stop(indexer); indexer = start(); snap = await caughtUp();
  assert.equal(JSON.stringify(canonical(snap)), beforeRestart);
  checks.push("Ponder start restart preserved same schema/database and checkpoint");
  // Outage is simulated only against our local proxy/Anvil.
  outage = true;
  await ew(renter, "cancel", [4n]);
  // Wait past the observation cache once; this is a short local fixture interval.
  await delay(5200);
  const status = await fetch(`${base}/sync`).then(r => r.json()) as any;
  assert.ok(status.rpcError); assert.equal(status.observedHead, null);
  const unavailable = await fetch(`${base}/graphql`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"query":"{ accounting(id: \"rental\") { liabilities } }"}' });
  assert.equal(unavailable.status, 503);
  outage = false; snap = await caughtUp();
  assert.equal(snap.tables.reservation.find(r => r.id === "4")!.status, "3");
  checks.push("read-only RPC outage reported and serving gated, followed by canonical catch-up");
  // Short reorg with same-height alternate block; mutate only this disposable chain.
  const snapshotId = await control("evm_snapshot");
  const orphan = await ew(nextAdmin, "setItemMetadata", [1n, "ipfs://orphan"]);
  await caughtUp();
  assert.equal((await snapshot()).tables.equipment[0].metadataURI, "ipfs://orphan");
  assert.equal(await control("evm_revert", [snapshotId]), true);
  await ew(nextAdmin, "setItemMetadata", [1n, "ipfs://canonical"]);
  await control("evm_mine");
  await until(snapshot, d => d.tables.equipment[0]?.metadataURI === "ipfs://canonical", "short reorg rollback/catch-up");
  await caughtUp();
  const orphanLogs = await fetch(`${base}/graphql`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: `{ eventRecords(where: { transactionHash: "${orphan.transactionHash}" }) { items { id } } }` }) }).then(r => r.json()) as any;
  assert.equal(orphanLogs.errors, undefined); assert.equal(orphanLogs.data.eventRecords.items.length, 0);
  snap = await caughtUp(); await reconcileSnapshot(snap, true, "post-reorg");
  checks.push("supported short reorg removed orphan event and restored canonical entities/accounting");
  await stop(indexer);
  // Same source/deployment, completely fresh data directory. Postgres uses a distinct owned schema.
  const freshDir = path.join(work, "fresh"); await mkdir(freshDir);
  for (const name of ["abis", "shared", "src", "ponder.config.ts", "ponder.schema.ts", "ponder-env.d.ts", "tsconfig.json", "package.json"]) await cp(path.join(root, name), path.join(freshDir, name), { recursive: true });
  await symlink(path.join(root, "node_modules"), path.join(freshDir, "node_modules"), "dir");
  indexer = start(`${schemaName}_fresh`, freshDir);
  const replay = await caughtUp();
  // SQL aggregation has no ordering contract. Compare each entity by primary key.
  assert.deepEqual(canonical(replay), canonical(snap));
  await reconcileSnapshot(replay, true, "fresh-replay");
  checks.push("fresh replay matches prior canonical entities and reconciles");
  evidence.ok = true;
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  evidence.ok = false; evidence.error = String(error); console.error(JSON.stringify(evidence, null, 2)); process.exitCode = 1;
} finally {
  await cleanup();
  // Keep only this run's own database/log fixtures under test/scratch for diagnosis.
  // Nothing pre-existing is deleted; no cloud or public-chain mutation is possible here.
  await writeFile(path.join(work, "result.json"), JSON.stringify(evidence, null, 2));
}
