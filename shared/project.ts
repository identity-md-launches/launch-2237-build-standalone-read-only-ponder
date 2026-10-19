import type { Store, Event, Tables } from "./model";
import { json } from "./config";
export const ZERO = "0x0000000000000000000000000000000000000000" as const;
export const lower = (a: string) => a.toLowerCase() as `0x${string}`;
export const initialAccounting = (): Tables["accounting"] => ({ id: "rental", escrowed: 0n, refundCredits: 0n, accruedFees: 0n, liabilities: 0n, refundsPaid: 0n, feesPaid: 0n, tokenBalance: 0n });

export async function apply(store: Store, e: Event, escrow: string) {
  const existing = await store.get("eventRecord", e.id);
  const record = { ...e, args: JSON.parse(json(e.args)) };
  if (existing) {
    if (json(existing) !== json(record)) throw new Error(`Conflicting duplicate ${e.id}`);
    return;
  }
  const a = e.args;
  const totals = await store.get("accounting", "rental") ?? initialAccounting();
  const getRenter = async (address: string) => await store.get("renter", lower(address)) ?? { id: lower(address), credit: 0n, depositsPaid: 0n, refundsPaid: 0n };
  const getReservation = async () => {
    const row = await store.get("reservation", BigInt(a.reservationId));
    if (!row) throw new Error("Missing reservation: incomplete history");
    return row;
  };
  const getItem = async () => {
    const row = await store.get("equipment", BigInt(a.itemId));
    if (!row) throw new Error("Missing equipment: incomplete history");
    return row;
  };
  const pay = async (kind: string, account: string, amount: bigint, reservationId: bigint | null = null, requestId: `0x${string}` | null = null) =>
    store.put("payment", { id: e.id, kind, account: lower(account), amount, reservationId, requestId, blockNumber: e.blockNumber, transactionHash: e.transactionHash });
  switch (e.name) {
    case "AdminTransferred": await store.put("administration", { id: "rental", admin: lower(a.newAdmin), pendingAdmin: ZERO }); break;
    case "AdminTransferStarted": await store.put("administration", { id: "rental", admin: lower(a.currentAdmin), pendingAdmin: lower(a.pendingAdmin) }); break;
    case "StaffUpdated": await store.put("staff", { id: lower(a.account), enabled: a.enabled }); break;
    case "PolicyCreated": await store.put("policy", { id: a.policyId, deposit: a.deposit, cancellationFee: a.cancellationFee, reservationWindow: a.reservationWindow }); break;
    case "ItemAdded": await store.put("equipment", { id: a.itemId, exists: true, listed: true, state: 0, policyId: a.policyId, activeReservationId: 0n, metadataURI: a.metadataURI }); break;
    case "ItemPolicyUpdated": await store.put("equipment", { ...await getItem(), policyId: a.newPolicyId }); break;
    case "ItemListingUpdated": await store.put("equipment", { ...await getItem(), listed: a.listed }); break;
    case "ItemMetadataUpdated": await store.put("equipment", { ...await getItem(), metadataURI: a.metadataURI }); break;
    case "ReservationCreated": {
      const p = await store.get("policy", a.policyId);
      if (!p) throw new Error("Missing policy");
      await store.put("reservation", { id: a.reservationId, itemId: a.itemId, renter: lower(a.renter), policyId: a.policyId, createdAt: e.timestamp, expiresAt: a.expiresAt, status: 1, deposit: a.deposit, cancellationFee: a.cancellationFee, reservationWindow: p.reservationWindow, clientRef: lower(a.clientRef) });
      await store.put("equipment", { ...await getItem(), state: 1, activeReservationId: a.reservationId });
      const r = await getRenter(a.renter); r.depositsPaid += a.deposit; await store.put("renter", r);
      totals.escrowed += a.deposit; await pay("DEPOSIT", a.renter, a.deposit, a.reservationId); break;
    }
    case "ItemCheckedOut": {
      await store.put("reservation", { ...await getReservation(), status: 2 });
      await store.put("equipment", { ...await getItem(), state: 2 }); break;
    }
    case "ReservationCancelled": case "ReservationExpired": case "ItemReturned": {
      const r = await getReservation();
      await store.put("reservation", { ...r, status: e.name === "ReservationCancelled" ? 3 : e.name === "ReservationExpired" ? 4 : 5 });
      await store.put("equipment", { ...await getItem(), state: 0, activeReservationId: 0n });
      totals.escrowed -= r.deposit; totals.accruedFees += a.fee ?? 0n; break;
    }
    // Credit is emitted before settlement; only this event increments credits.
    case "RefundCredited": {
      const r = await getRenter(a.beneficiary); r.credit += a.amount; await store.put("renter", r);
      totals.refundCredits += a.amount; await pay("CREDIT", a.beneficiary, a.amount, a.reservationId); break;
    }
    case "RefundWithdrawn": {
      const r = await getRenter(a.beneficiary); r.credit -= a.amount; r.refundsPaid += a.amount; await store.put("renter", r);
      totals.refundCredits -= a.amount; totals.refundsPaid += a.amount;
      await pay("REFUND", a.beneficiary, a.amount); break;
    }
    case "FeesWithdrawn": {
      const id = lower(a.requestId);
      if (await store.get("feeRequest", id)) throw new Error("Repeated completed fee request");
      await store.put("feeRequest", { id, recipient: lower(a.to), amount: a.amount, completed: true, transactionHash: e.transactionHash, blockNumber: e.blockNumber });
      totals.accruedFees -= a.amount; totals.feesPaid += a.amount; await pay("FEE", a.to, a.amount, null, id); break;
    }
    case "Transfer": {
      const from = lower(a.from), to = lower(a.to);
      if (from !== ZERO) { const row = await store.get("tokenAccount", from) ?? { id: from, balance: 0n }; row.balance -= a.value; await store.put("tokenAccount", row); }
      if (to !== ZERO) { const row = await store.get("tokenAccount", to) ?? { id: to, balance: 0n }; row.balance += a.value; await store.put("tokenAccount", row); }
      if (from === lower(escrow)) totals.tokenBalance -= a.value;
      if (to === lower(escrow)) totals.tokenBalance += a.value;
      const t = await store.get("token", e.contract);
      if (!t) throw new Error("Token metadata setup missing");
      if (from === ZERO) t.totalSupply += a.value;
      if (to === ZERO) t.totalSupply -= a.value;
      await store.put("token", t); break;
    }
    case "Approval": await store.put("allowance", { id: `${lower(a.owner)}:${lower(a.spender)}`, owner: lower(a.owner), spender: lower(a.spender), amount: a.value }); break;
    default: throw new Error(`Unhandled event ${e.name}`);
  }
  totals.liabilities = totals.escrowed + totals.refundCredits + totals.accruedFees;
  await store.put("accounting", totals);
  await store.put("eventRecord", record);
}
