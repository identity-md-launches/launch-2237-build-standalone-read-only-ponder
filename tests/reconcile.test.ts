import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeEventTopics, encodeAbiParameters, parseAbiParameters } from "viem";
import { RentalEscrowAbi } from "../abis/RentalEscrow";
import { reconcile } from "../shared/reconcile";
import { expectedCode } from "../shared/code";
import { settings as s } from "../shared/config";
import { initialAccounting, lower, ZERO } from "../shared/project";
import { MemoryStore, addr, hash } from "./memory";

// Independent mocked RPC fixture; storage and raw ABI-encoded logs do not invoke the projection.
async function fixture() {
  const m = new MemoryStore();
  const end = BigInt(s.escrowStart + 10), h = hash(900), tx = hash(901), staff = addr(3), fee = hash(44);
  await m.put("checkpoint", { id: "rental", chainId: s.chainId, blockNumber: end, blockHash: h, timestamp: 1000n });
  await m.put("administration", { id: "rental", admin: addr(1), pendingAdmin: ZERO });
  await m.put("staff", { id: staff, enabled: false });
  const amount = 2n ** 100n;
  await m.put("feeRequest", { id: fee, recipient: addr(2), amount, completed: true, transactionHash: tx, blockNumber: end });
  await m.put("accounting", { ...initialAccounting(), feesPaid: amount, refundsPaid: amount + 1n });
  await m.put("renter", { id: addr(1), credit: 0n, depositsPaid: 0n, refundsPaid: amount + 1n });
  await m.put("token", { id: lower(s.token), name: "kkk", symbol: "dds", decimals: 6, totalSupply: 1000000000000n });
  const log = (topics: any, data: `0x${string}`, index: number, block = end) => ({ address: s.escrow, topics, data, blockNumber: block, blockHash: block === end ? h : hash(899), transactionHash: tx, transactionIndex: 0, logIndex: index, removed: false });
  const logs = [
    log(encodeEventTopics({ abi: RentalEscrowAbi, eventName: "AdminTransferred", args: { previousAdmin: ZERO, newAdmin: addr(1) } }), "0x", 0, BigInt(s.escrowStart)),
    log(encodeEventTopics({ abi: RentalEscrowAbi, eventName: "StaffUpdated", args: { account: staff } }), encodeAbiParameters(parseAbiParameters("bool"), [true]), 0),
    log(encodeEventTopics({ abi: RentalEscrowAbi, eventName: "StaffUpdated", args: { account: staff } }), encodeAbiParameters(parseAbiParameters("bool"), [false]), 1),
    log(encodeEventTopics({ abi: RentalEscrowAbi, eventName: "FeesWithdrawn", args: { requestId: fee, to: addr(2) } }), encodeAbiParameters(parseAbiParameters("uint256"), [amount]), 2),
    log(encodeEventTopics({ abi: RentalEscrowAbi, eventName: "RefundWithdrawn", args: { beneficiary: addr(1) } }), encodeAbiParameters(parseAbiParameters("uint256"), [amount + 1n]), 3),
  ];
  let endReads = 0;
  const faults = { wrongChain: false, badHash: false, changedAfter: false, unavailable: false, malformed: false, noncanonicalLog: false, conflict: false, duplicate: false, badTransaction: false, badCode: false };
  const client: any = {
    getChainId: async () => faults.wrongChain ? 1 : s.chainId,
    getCode: async ({ address, blockNumber }: any) => blockNumber < BigInt(s.escrowStart) ? "0x" : faults.badCode ? "0x6000" : expectedCode(address === s.token ? "MockPaymentToken" : "RentalEscrow", s.token),
    getBlock: async ({ blockNumber }: any) => {
      const bh = blockNumber === end ? h : hash(899);
      if (blockNumber === end) endReads++;
      const changed = faults.changedAfter && endReads >= 4 && blockNumber === end;
      return { number: blockNumber, hash: faults.badHash || changed ? hash(902) : bh, timestamp: 1000n, transactions: [faults.badTransaction ? hash(903) : tx] };
    },
    getLogs: async ({ fromBlock, toBlock }: any) => {
      if (faults.unavailable) throw new Error("history unavailable");
      let filtered = logs.filter(l => l.blockNumber >= fromBlock && l.blockNumber <= toBlock).map(l => ({ ...l }));
      if (faults.malformed && filtered[0]) filtered[0].topics = [hash(777)];
      if (faults.noncanonicalLog && filtered[0]) filtered[0].blockHash = hash(990);
      if (faults.duplicate) filtered = [...filtered].reverse().flatMap(l => [l, { ...l }]);
      if (faults.conflict && filtered[0]) filtered.push({ ...filtered[0], data: "0xab" });
      return filtered;
    },
    readContract: async ({ functionName, args = [], blockNumber }: any) => {
      assert.equal(blockNumber, end, "ALL storage calls pin checkpoint, never latest");
      switch (functionName) {
        case "policyCount": case "itemCount": case "reservationCount": case "totalEscrowed": case "totalRefundCredits": case "accruedFees": case "totalLiabilities": case "refundCreditOf": return 0n;
        case "admin": return addr(1); case "pendingAdmin": return ZERO; case "token": return s.token;
        case "isStaff": return false;
        case "feeWithdrawalById": assert.equal(args[0], fee); return [addr(2), amount, true];
        case "balanceOf": return 0n; case "name": return "kkk"; case "symbol": return "dds"; case "decimals": return 6; case "totalSupply": return 1000000000000n;
        default: throw new Error(`Unexpected ${functionName}`);
      }
    },
  };
  return { snapshot: m.snapshot(), client, faults, fee, staff };
}
test("valid history, disabled staff, duplicates and >2^53 payments pass", async () => {
  const f = await fixture(); f.faults.duplicate = true;
  assert.equal((await reconcile(f.snapshot, s, f.client)).ok, true);
});
for (const kind of ["missingFee", "extraFee", "missingStaff", "extraStaff", "refundsPaid", "feesPaid", "feeTx", "staffState"] as const) {
  test(`reconciliation rejects ${kind} without mutating input`, async () => {
    const f = await fixture(), d = f.snapshot;
    switch (kind) {
      case "missingFee": d.tables.feeRequest = []; break;
      case "extraFee": d.tables.feeRequest.push({ ...d.tables.feeRequest[0], id: hash(666) }); break;
      case "missingStaff": d.tables.staff = []; break;
      case "extraStaff": d.tables.staff.push({ id: addr(666), enabled: "false" }); break;
      case "refundsPaid": d.tables.accounting[0].refundsPaid = "0"; break;
      case "feesPaid": d.tables.accounting[0].feesPaid = "0"; break;
      case "feeTx": d.tables.feeRequest[0].transactionHash = hash(888); break;
      case "staffState": d.tables.staff[0].enabled = "true"; break;
    }
    const before = structuredClone(d);
    await assert.rejects(reconcile(d, s, f.client), /RECONCILIATION FAILED/);
    assert.deepEqual(d, before);
  });
}
for (const fault of ["wrongChain", "badHash", "changedAfter", "unavailable", "malformed", "noncanonicalLog", "conflict", "badTransaction", "badCode"] as const) {
  test(`rejects RPC evidence: ${fault}`, async () => {
    const f = await fixture(); f.faults[fault] = true;
    await assert.rejects(reconcile(f.snapshot, s, f.client));
  });
}

test("independent event and state providers must agree on chain and closing hash", async () => {
  const f = await fixture();
  const other = { ...f.client, getChainId: async () => 1 };
  await assert.rejects(reconcile(f.snapshot, s, f.client, other), /Event RPC chain/);
  const g = await fixture();
  const disagree = { ...g.client, getBlock: async (args: any) => ({ ...await g.client.getBlock(args), hash: hash(999) }) };
  await assert.rejects(reconcile(g.snapshot, s, g.client, disagree), /disagreement/);
});
