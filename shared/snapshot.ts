export const columns = {
  policy: ["id", "deposit", "cancellationFee", "reservationWindow"],
  equipment: ["id", "exists", "listed", "state", "policyId", "activeReservationId", "metadataURI"],
  reservation: ["id", "itemId", "renter", "policyId", "createdAt", "expiresAt", "status", "deposit", "cancellationFee", "reservationWindow", "clientRef"],
  renter: ["id", "credit", "depositsPaid", "refundsPaid"],
  staff: ["id", "enabled"], administration: ["id", "admin", "pendingAdmin"],
  feeRequest: ["id", "recipient", "amount", "completed", "transactionHash", "blockNumber"],
  accounting: ["id", "escrowed", "refundCredits", "accruedFees", "liabilities", "refundsPaid", "feesPaid", "tokenBalance"],
  tokenAccount: ["id", "balance"], allowance: ["id", "owner", "spender", "amount"],
  token: ["id", "name", "symbol", "decimals", "totalSupply"],
  checkpoint: ["id", "chainId", "blockNumber", "blockHash", "timestamp"],
} as const;
export type SnapshotRow = Record<string, string | null>;
export type Snapshot = {
  version: 1;
  deployment: { chainId: number; token: string; escrow: string; tokenStart: number; escrowStart: number };
  tables: { -readonly [K in keyof typeof columns]: SnapshotRow[] };
  eventMaxBlock: string | null;
};
