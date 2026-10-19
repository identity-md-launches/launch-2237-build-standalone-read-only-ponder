import { decodeEventLog, type Hex } from "viem";
import { RentalEscrowAbi } from "../abis/RentalEscrow";
import { MockPaymentTokenAbi } from "../abis/MockPaymentToken";
import { json, type Settings } from "./config";
import { rpcClient, scanLogs, verifyIdentity, type ReadClient } from "./rpc";
import type { Snapshot, SnapshotRow } from "./snapshot";
import { ZERO, lower } from "./project";

// Independent evidence audit: never reads projected identities or history to choose logs to scan.
export async function auditEvents(client: ReadClient, s: Settings, end: bigint) {
  const logs = await scanLogs(client, s.escrow, BigInt(s.escrowStart), end, s.logRange);
  const staff = new Map<string, boolean>();
  const fees = new Map<string, { recipient: string; amount: bigint; completed: boolean; transactionHash: string; blockNumber: bigint }>();
  const renters = new Set<string>();
  const depositsByRenter = new Map<string, bigint>(), refundsByRenter = new Map<string, bigint>();
  let refundsPaid = 0n, feesPaid = 0n, deploymentSeen = false;
  const headers = new Map<bigint, Awaited<ReturnType<ReadClient["getBlock"]>>>();
  for (const log of logs) {
    let header = headers.get(log.blockNumber!);
    if (!header) { header = await client.getBlock({ blockNumber: log.blockNumber! }); headers.set(log.blockNumber!, header); }
    if (header.number !== log.blockNumber || header.hash !== log.blockHash || header.transactions[log.transactionIndex!] !== log.transactionHash) throw new Error("Noncanonical RPC log/block/transaction evidence");
    const e = decodeEventLog({ abi: RentalEscrowAbi, topics: log.topics, data: log.data, strict: true });
    switch (e.eventName) {
      case "AdminTransferred":
        if (lower(e.args.previousAdmin) === ZERO) {
          if (deploymentSeen) throw new Error("Bad deployment boundary evidence");
          deploymentSeen = true;
        }
        break;
      case "StaffUpdated": staff.set(lower(e.args.account), e.args.enabled); break;
      case "ReservationCreated": {
        const id = lower(e.args.renter); renters.add(id); depositsByRenter.set(id, (depositsByRenter.get(id) ?? 0n) + e.args.deposit); break;
      }
      case "FeesWithdrawn": {
        const id = lower(e.args.requestId);
        if (fees.has(id) || e.args.amount <= 0n) throw new Error("Conflicting fee-request evidence");
        fees.set(id, { recipient: lower(e.args.to), amount: e.args.amount, completed: true, transactionHash: log.transactionHash!, blockNumber: log.blockNumber! });
        feesPaid += e.args.amount; break;
      }
      case "RefundWithdrawn":
        if (e.args.amount <= 0n) throw new Error("Invalid refund payment evidence");
        renters.add(lower(e.args.beneficiary)); refundsPaid += e.args.amount;
        refundsByRenter.set(lower(e.args.beneficiary), (refundsByRenter.get(lower(e.args.beneficiary)) ?? 0n) + e.args.amount); break;
      case "RefundCredited": renters.add(lower(e.args.beneficiary)); break;
    }
  }
  if (!deploymentSeen) throw new Error("Missing constructor event: history unavailable or wrong start block");
  return { staff, fees, renters, depositsByRenter, refundsByRenter, refundsPaid, feesPaid };
}
function normalized(v: unknown): string {
  return typeof v === "string" && v.startsWith("0x") ? v.toLowerCase() : String(v);
}
export async function reconcile(data: Snapshot, s: Settings, client: ReadClient = rpcClient({ ...s, rpcUrl: s.stateRpcUrl || s.rpcUrl }), eventClient: ReadClient = s.stateRpcUrl ? rpcClient(s) : client) {
  if (data.version !== 1) throw new Error("Unsupported snapshot version");
  const identity = { chainId: s.chainId, token: lower(s.token), escrow: lower(s.escrow), tokenStart: s.tokenStart, escrowStart: s.escrowStart };
  if (json(data.deployment) !== json(identity)) throw new Error("Snapshot deployment identity mismatch");
  if (data.tables.checkpoint.length !== 1) throw new Error("Missing/extra checkpoint");
  const cp = data.tables.checkpoint[0];
  const blockNumber = BigInt(cp.blockNumber!);
  if (cp.chainId !== String(s.chainId) || (data.eventMaxBlock && BigInt(data.eventMaxBlock) > blockNumber)) throw new Error("Incomplete/mixed checkpoint");
  await verifyIdentity(client, s, blockNumber);
  const before = await client.getBlock({ blockNumber });
  if (before.number !== blockNumber || before.hash !== cp.blockHash || String(before.timestamp) !== cp.timestamp) throw new Error("Snapshot block is not canonical");
  if (await eventClient.getChainId() !== s.chainId) throw new Error("Event RPC chain identity mismatch");
  const eventBefore = await eventClient.getBlock({ blockNumber });
  if (eventBefore.hash !== before.hash || eventBefore.number !== blockNumber) throw new Error("Event/state RPC canonical block disagreement");
  const expected = await auditEvents(eventClient, s, blockNumber);
  const errors: string[] = [];
  const equal = (label: string, a: unknown, b: unknown) => { if (normalized(a) !== normalized(b)) errors.push(`${label}: indexed=${String(a)} chain=${String(b)}`); };
  const maps = Object.fromEntries(Object.entries(data.tables).map(([name, rows]) => {
    const map = new Map<string, SnapshotRow>();
    for (const row of rows) { if (!row.id || map.has(row.id)) throw new Error(`Missing/duplicate ${name} primary key`); map.set(row.id, row); }
    return [name, map];
  }));
  const membership = (name: string, ids: Iterable<string>) => {
    const wanted = new Set(ids), local = maps[name];
    for (const id of wanted) if (!local.has(id)) errors.push(`Missing ${name} ${id}`);
    for (const id of local.keys()) if (!wanted.has(id)) errors.push(`Extra ${name} ${id}`);
  };
  const read = (functionName: string, args: unknown[] = []) => client.readContract({ address: s.escrow, abi: RentalEscrowAbi, functionName, args, blockNumber } as any) as Promise<any>;
  const fields = (name: string, local: SnapshotRow | undefined, chain: Record<string, unknown>) => {
    for (const [field, value] of Object.entries(chain)) equal(`${name}.${field}`, local?.[field], value);
  };
  for (const [table, countFn, getFn] of [["policy", "policyCount", "getPolicy"], ["equipment", "itemCount", "getItem"], ["reservation", "reservationCount", "getReservation"]]) {
    const count = BigInt(await read(countFn));
    // Explicit resource limit; never return success on a partial audit.
    if (count > 100000n) throw new Error("Audit entity limit exceeded; raise reviewed implementation limit");
    const ids = Array.from({ length: Number(count) }, (_, i) => String(i + 1));
    membership(table, ids);
    for (const id of ids) {
      const chain = await read(getFn, [BigInt(id)]);
      const row = maps[table].get(id);
      fields(`${table} ${id}`, row, chain);
      if (table === "reservation") {
        const policy = await read("getPolicy", [chain.policyId]);
        equal(`reservation ${id}.reservationWindow`, row?.reservationWindow, policy.reservationWindow);
        equal(`reservation ${id}.accepted deposit`, row?.deposit, policy.deposit);
        equal(`reservation ${id}.accepted fee`, row?.cancellationFee, policy.cancellationFee);
        equal(`reservation ${id}.expiresAt`, row?.expiresAt, chain.createdAt + policy.reservationWindow);
        equal(`reservationByRef ${id}`, id, await read("reservationByRef", [chain.renter, chain.clientRef]));
      }
    }
  }
  membership("staff", expected.staff.keys());
  for (const [id, enabled] of expected.staff) {
    equal(`staff ${id}`, maps.staff.get(id)?.enabled, enabled);
    equal(`staff event/storage ${id}`, enabled, await read("isStaff", [id]));
  }
  membership("feeRequest", expected.fees.keys());
  for (const [id, fee] of expected.fees) {
    fields(`feeRequest ${id}`, maps.feeRequest.get(id), fee);
    const [recipient, amount, completed] = await read("feeWithdrawalById", [id]);
    equal(`fee storage ${id}.recipient`, fee.recipient, recipient); equal(`fee storage ${id}.amount`, fee.amount, amount); equal(`fee storage ${id}.completed`, fee.completed, completed);
  }
  membership("administration", ["rental"]); membership("accounting", ["rental"]);
  const admin = maps.administration.get("rental");
  equal("admin", admin?.admin, await read("admin")); equal("pendingAdmin", admin?.pendingAdmin, await read("pendingAdmin"));
  equal("payment token", lower(s.token), await read("token"));
  membership("renter", expected.renters);
  let credits = 0n;
  for (const id of expected.renters) {
    const credit = await read("refundCreditOf", [id]);
    equal(`credit ${id}`, maps.renter.get(id)?.credit, credit); credits += credit;
    equal(`deposits paid ${id}`, maps.renter.get(id)?.depositsPaid, expected.depositsByRenter.get(id) ?? 0n);
    equal(`refunds paid ${id}`, maps.renter.get(id)?.refundsPaid, expected.refundsByRenter.get(id) ?? 0n);
  }
  const totals = maps.accounting.get("rental");
  equal("sum credits", totals?.refundCredits, credits);
  equal("refundsPaid", totals?.refundsPaid, expected.refundsPaid); equal("feesPaid", totals?.feesPaid, expected.feesPaid);
  for (const [field, method] of [["escrowed", "totalEscrowed"], ["refundCredits", "totalRefundCredits"], ["accruedFees", "accruedFees"], ["liabilities", "totalLiabilities"]]) equal(field, totals?.[field], await read(method));
  const tokenRead = (functionName: string, args: unknown[] = []) => client.readContract({ address: s.token, abi: MockPaymentTokenAbi, functionName, args, blockNumber } as any) as Promise<any>;
  const balance: bigint = await tokenRead("balanceOf", [s.escrow]);
  const liabilities: bigint = await read("totalLiabilities");
  equal("token balance", totals?.tokenBalance, balance);
  if (balance < liabilities) errors.push("Token balance below liabilities");
  membership("token", [lower(s.token)]);
  fields("token metadata", maps.token.get(lower(s.token)), { name: await tokenRead("name"), symbol: await tokenRead("symbol"), decimals: await tokenRead("decimals"), totalSupply: await tokenRead("totalSupply") });
  // Token-account membership and historical payment-row provenance are outside this audit;
  // existing account balances still must agree with storage at the anchored block.
  for (const [id, account] of maps.tokenAccount) equal(`token account ${id}`, account.balance, await tokenRead("balanceOf", [id]));
  const after = await client.getBlock({ blockNumber });
  const eventAfter = await eventClient.getBlock({ blockNumber });
  if (eventAfter.number !== blockNumber || eventAfter.hash !== before.hash || after.number !== blockNumber || after.hash !== before.hash) throw new Error("Canonical block changed during reconciliation");
  if (errors.length) throw new Error(`RECONCILIATION FAILED at ${blockNumber}:\n${errors.join("\n")}`);
  return { ok: true, blockNumber: String(blockNumber), blockHash: before.hash, refundsPaid: String(expected.refundsPaid), feesPaid: String(expected.feesPaid), tokenBalance: String(balance), liabilities: String(liabilities), donationSurplus: String(balance - liabilities) };
}
