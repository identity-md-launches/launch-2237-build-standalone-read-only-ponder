import { verifyCode } from "../shared/code";
import assert from "node:assert/strict";
import { settings, json } from "../shared/config";
import { rpcClient, scanLogs } from "../shared/rpc";
import { auditEvents } from "../shared/reconcile";
import { RentalEscrowAbi } from "../abis/RentalEscrow";
import { MockPaymentTokenAbi } from "../abis/MockPaymentToken";
import { keccak256, decodeEventLog } from "viem";
const blockNumber = 138754466n;
const expectedHash = "0x198390e8346394fda55e74abb43cce543aff5768667adbf14bfc1c873bf90bad";
if (settings.chainId !== 46630) throw new Error("Public verification only supports supplied trial");
const rpc = rpcClient(settings);
const stateRpc = rpcClient({ ...settings, rpcUrl: settings.stateRpcUrl || settings.rpcUrl });
const evidence: any = { endpoint: settings.rpcUrl, stateEndpoint: settings.stateRpcUrl || settings.rpcUrl, fixedBlock: String(blockNumber), checks: {}, errors: [] };
async function check(name: string, fn: () => Promise<unknown>) {
  try { evidence.checks[name] = await fn(); } catch (e) { evidence.errors.push({ check: name, error: String(e) }); }
}
await check("chainIdentity", async () => { const id = await rpc.getChainId(); if (id !== 46630) throw new Error("Wrong chain"); return id; });
if (evidence.errors.length) { console.log(json(evidence)); process.exit(1); }
await check("canonicalBlock", async () => { const b = await rpc.getBlock({ blockNumber }); if (b.hash !== expectedHash) throw new Error(`Noncanonical supplied hash: ${b.hash}`); return { number: b.number, hash: b.hash, timestamp: b.timestamp }; });
await check("stateProviderAnchor", async () => {
  assert.equal(await stateRpc.getChainId(), 46630);
  const block = await stateRpc.getBlock({ blockNumber }); assert.equal(block.hash, expectedHash); return { number: block.number, hash: block.hash };
});
for (const [name, address, start] of [["token", settings.token, settings.tokenStart], ["escrow", settings.escrow, settings.escrowStart]] as const) {
  await check(`${name}CodeAtExample`, async () => { const code = await stateRpc.getCode({ address, blockNumber }); verifyCode(name === "token" ? "MockPaymentToken" : "RentalEscrow", code, settings.token); return { bytes: (code!.length - 2) / 2, keccak256: keccak256(code!) }; });
  await check(`${name}DeploymentBoundary`, async () => {
    const before = await stateRpc.getCode({ address, blockNumber: BigInt(start - 1) }); assert.ok(before === undefined || before === "0x", "Code must be absent before deployment");
    const at = await stateRpc.getCode({ address, blockNumber: BigInt(start) });
    verifyCode(name === "token" ? "MockPaymentToken" : "RentalEscrow", at, settings.token);
    return { beforeCodeAbsent: true, atCodeHash: keccak256(at!) };
  });
}
if (!process.argv.includes("--storage-only")) await check("escrowEventAudit", async () => { const a = await auditEvents(rpc, settings, blockNumber); assert.equal(a.refundsPaid, 45000000n); assert.equal(a.feesPaid, 5000000n); assert.equal(a.fees.size, 1);
    return { staff: Object.fromEntries(a.staff), fees: Object.fromEntries(a.fees), renters: [...a.renters], refundsPaid: a.refundsPaid, feesPaid: a.feesPaid }; });
if (!process.argv.includes("--storage-only")) await check("discoveredEscrowEvents", async () => {
  const logs = await scanLogs(rpc, settings.escrow, BigInt(settings.escrowStart), blockNumber, settings.logRange);
  return logs.map(l => ({ block: l.blockNumber, blockHash: l.blockHash, transactionHash: l.transactionHash, logIndex: l.logIndex, ...decodeEventLog({ abi: RentalEscrowAbi, topics: l.topics, data: l.data, strict: true }) }));
});
await check("fixedStorage", async () => {
  const read = (functionName: string, args: unknown[] = []) => stateRpc.readContract({ address: settings.escrow, abi: RentalEscrowAbi, functionName, args, blockNumber } as any);
  const result: Record<string, unknown> = {};
  for (const name of ["admin", "pendingAdmin", "token", "policyCount", "itemCount", "reservationCount", "totalEscrowed", "totalRefundCredits", "accruedFees", "totalLiabilities"]) result[name] = await read(name);
  result.policy = await read("getPolicy", [1n]); result.item = await read("getItem", [1n]); result.reservation = await read("getReservation", [1n]);
  result.credit = await read("refundCreditOf", ["0x0fF6617f72544f60802b72D752dA7490C304CdeE"]);
  result.feeRequest = await read("feeWithdrawalById", ["0xb5d4ba7e1b0d63f8be844a65244059d1f8808692685ecd0fd3778d676e543b78"]);
  const tr = (functionName: string, args: unknown[] = []) => stateRpc.readContract({ address: settings.token, abi: MockPaymentTokenAbi, functionName, args, blockNumber } as any);
  result.decimals = await tr("decimals"); result.supply = await tr("totalSupply"); result.escrowBalance = await tr("balanceOf", [settings.escrow]); result.holderBalance = await tr("balanceOf", ["0x0fF6617f72544f60802b72D752dA7490C304CdeE"]);
  const testAccount = "0x0ff6617f72544f60802b72d752da7490c304cdee";
  assert.equal(String(result.admin).toLowerCase(), testAccount);
  for (const name of ["policyCount", "itemCount", "reservationCount"]) assert.equal(String(result[name]), "1");
  for (const name of ["totalEscrowed", "totalRefundCredits", "accruedFees", "totalLiabilities", "escrowBalance", "credit"]) assert.equal(String(result[name]), "0");
  assert.equal(String(result.decimals), "6"); assert.equal(String(result.supply), "1000000000000"); assert.equal(String(result.holderBalance), "1000000000000");
  const policy = result.policy as any, item = result.item as any, reservation = result.reservation as any;
  assert.equal(policy.deposit, 50000000n); assert.equal(policy.cancellationFee, 5000000n); assert.equal(policy.reservationWindow, 86400n);
  assert.equal(item.state, 0); assert.equal(item.listed, true); assert.equal(item.activeReservationId, 0n);
  assert.equal(reservation.itemId, 1n); assert.equal(reservation.policyId, 1n); assert.equal(item.policyId, 1n);
  assert.equal(reservation.status, 3); assert.equal(reservation.deposit, 50000000n); assert.equal(reservation.cancellationFee, 5000000n);
  assert.equal(reservation.expiresAt - reservation.createdAt, 86400n); assert.equal(reservation.renter.toLowerCase(), testAccount);
  assert.equal(reservation.clientRef, "0x0f3fcf2d397cb63077da241a2b9b0a8762d96b745c235f2e1993c749ba1aeaac");
  assert.deepEqual((result.feeRequest as any[]).map(String).map(v => v.toLowerCase()), [testAccount, "5000000", "true"]);
  return result;
});
await check("canonicalAfter", async () => { const b = await rpc.getBlock({ blockNumber }); if (b.hash !== expectedHash) throw new Error("Canonical block changed"); return b.hash; });
await check("stateProviderAnchorAfter", async () => { const b = await stateRpc.getBlock({ blockNumber }); assert.equal(b.hash, expectedHash); return b.hash; });
console.log(json(evidence));
if (evidence.errors.length) process.exitCode = 1;
