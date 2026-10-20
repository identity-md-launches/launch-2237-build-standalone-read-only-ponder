import { test } from "node:test";
import assert from "node:assert/strict";
import "./health.test";
import "./serving.test";
import { apply, ZERO } from "../shared/project";
import { settings } from "../shared/config";
import { MemoryStore, addr, hash, event, json } from "./memory";

async function base() {
  const store = new MemoryStore();
  await apply(store, event("PolicyCreated", { policyId: 1n, deposit: 50000000n, cancellationFee: 5000000n, reservationWindow: 86400n }, 1), settings.escrow);
  await apply(store, event("ItemAdded", { itemId: 1n, policyId: 1n, metadataURI: "ipfs://equipment" }, 2), settings.escrow);
  return store;
}
const booking = { reservationId: 1n, itemId: 1n, renter: addr(1), policyId: 1n, deposit: 50000000n, cancellationFee: 5000000n, expiresAt: 87403n, clientRef: hash(1) };
test("accepted terms survive policy replacement and cancellation; duplicate logs do not double count", async () => {
  const store = await base();
  const e = event("ReservationCreated", booking, 3);
  await apply(store, e, settings.escrow);
  const before = json([...store.rows].map(([table, rows]) => [table, [...rows]]));
  await apply(store, e, settings.escrow);
  assert.equal(json([...store.rows].map(([table, rows]) => [table, [...rows]])), before);
  await apply(store, event("PolicyCreated", { policyId: 2n, deposit: 100n, cancellationFee: 20n, reservationWindow: 60n }, 4), settings.escrow);
  await apply(store, event("ItemPolicyUpdated", { itemId: 1n, newPolicyId: 2n }, 5), settings.escrow);
  await apply(store, event("RefundCredited", { beneficiary: addr(1), reservationId: 1n, amount: 45000000n }, 6), settings.escrow);
  await apply(store, event("ReservationCancelled", { ...booking, refund: 45000000n, fee: 5000000n }, 7), settings.escrow);
  await apply(store, event("RefundWithdrawn", { beneficiary: addr(1), amount: 45000000n }, 8), settings.escrow);
  await apply(store, event("FeesWithdrawn", { requestId: hash(10), to: addr(2), amount: 5000000n }, 9), settings.escrow);
  const r = await store.get("reservation", 1n), t = await store.get("accounting", "rental");
  assert.equal(r?.status, 3); assert.equal(r?.deposit, 50000000n); assert.equal(r?.reservationWindow, 86400n);
  assert.equal((await store.get("equipment", 1n))?.policyId, 2n);
  assert.equal(t?.liabilities, 0n); assert.equal(t?.refundsPaid, 45000000n); assert.equal(t?.feesPaid, 5000000n);
  await assert.rejects(apply(store, { ...e, args: { ...booking, deposit: 1n } }, settings.escrow), /Conflicting duplicate/);
});
test("checkout, return, expiry and revoked staff remain queryable", async () => {
  const store = await base();
  await apply(store, event("StaffUpdated", { account: addr(3), enabled: true }, 3), settings.escrow);
  await apply(store, event("StaffUpdated", { account: addr(3), enabled: false }, 4), settings.escrow);
  assert.equal((await store.get("staff", addr(3)))?.enabled, false);
  await apply(store, event("ReservationCreated", booking, 5), settings.escrow);
  await apply(store, event("ItemCheckedOut", { reservationId: 1n, itemId: 1n, staff: addr(3) }, 6), settings.escrow);
  assert.equal((await store.get("equipment", 1n))?.state, 2);
  await apply(store, event("RefundCredited", { beneficiary: addr(1), reservationId: 1n, amount: 50000000n }, 7), settings.escrow);
  await apply(store, event("ItemReturned", { reservationId: 1n, itemId: 1n, staff: addr(3), refund: 50000000n }, 8), settings.escrow);
  assert.equal((await store.get("reservation", 1n))?.status, 5);
  await apply(store, event("ReservationCreated", { ...booking, reservationId: 2n, clientRef: hash(2) }, 9), settings.escrow);
  await apply(store, event("RefundCredited", { beneficiary: addr(1), reservationId: 2n, amount: 45000000n }, 10), settings.escrow);
  await apply(store, event("ReservationExpired", { ...booking, reservationId: 2n, refund: 45000000n, fee: 5000000n, caller: addr(4) }, 11), settings.escrow);
  assert.equal((await store.get("reservation", 2n))?.status, 4);
  assert.equal((await store.get("accounting", "rental"))?.liabilities, 100000000n);
});
test("token balances, mint, approvals and donations use exact integers", async () => {
  const store = new MemoryStore();
  await store.put("token", { id: settings.token, name: "kkk", symbol: "dds", decimals: 6, totalSupply: 0n });
  const amount = 2n ** 200n;
  await apply(store, { ...event("Transfer", { from: ZERO, to: addr(1), value: amount }, 1), contract: settings.token }, settings.escrow);
  await apply(store, { ...event("Transfer", { from: addr(1), to: settings.escrow, value: 123n }, 2), contract: settings.token }, settings.escrow);
  await apply(store, event("Approval", { owner: addr(1), spender: settings.escrow, value: amount }, 3), settings.escrow);
  assert.equal((await store.get("tokenAccount", addr(1)))?.balance, amount - 123n);
  assert.equal((await store.get("accounting", "rental"))?.tokenBalance, 123n);
  assert.equal((await store.get("token", settings.token))?.totalSupply, amount);
});

test("read transport blocks transactions and distinguishes empty code from unavailable evidence", async () => {
  const { createServer } = await import("node:http");
  const { rpcClient } = await import("../shared/rpc");
  let result: string | null = "0x", requests = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* consume this unit fixture's request */ }
    requests++; res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  });
  server.listen(0, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
  const port = (server.address() as { port: number }).port;
  try {
    const client = rpcClient({ rpcUrl: `http://127.0.0.1:${port}`, timeout: 1000 });
    await assert.rejects(client.request({ method: "eth_sendTransaction", params: [] } as any), /not read-only/);
    assert.equal(requests, 0);
    assert.equal(await client.getCode({ address: addr(1), blockNumber: 1n }), undefined);
    result = null;
    await assert.rejects(client.getCode({ address: addr(1), blockNumber: 1n }), /Malformed RPC hex/);
  } finally {
    server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
  }
});
