import { onchainTable, index, relations } from "ponder";

export const policy = onchainTable("policy", t => ({
  id: t.bigint().primaryKey(), deposit: t.bigint().notNull(), cancellationFee: t.bigint().notNull(), reservationWindow: t.bigint().notNull(),
}));
export const equipment = onchainTable("equipment", t => ({
  id: t.bigint().primaryKey(), exists: t.boolean().notNull(), listed: t.boolean().notNull(), state: t.integer().notNull(),
  policyId: t.bigint().notNull(), activeReservationId: t.bigint().notNull(), metadataURI: t.text().notNull(),
}), t => ({ availability: index().on(t.listed, t.state) }));
export const reservation = onchainTable("reservation", t => ({
  id: t.bigint().primaryKey(), itemId: t.bigint().notNull(), renter: t.hex().notNull(), policyId: t.bigint().notNull(),
  createdAt: t.bigint().notNull(), expiresAt: t.bigint().notNull(), status: t.integer().notNull(),
  deposit: t.bigint().notNull(), cancellationFee: t.bigint().notNull(), reservationWindow: t.bigint().notNull(), clientRef: t.hex().notNull(),
}), t => ({ renter: index().on(t.renter), clientRef: index().on(t.renter, t.clientRef) }));
export const renter = onchainTable("renter", t => ({
  id: t.hex().primaryKey(), credit: t.bigint().notNull(), depositsPaid: t.bigint().notNull(), refundsPaid: t.bigint().notNull(),
}));
export const staff = onchainTable("staff", t => ({ id: t.hex().primaryKey(), enabled: t.boolean().notNull() }));
export const administration = onchainTable("administration", t => ({ id: t.text().primaryKey(), admin: t.hex().notNull(), pendingAdmin: t.hex().notNull() }));
export const feeRequest = onchainTable("fee_request", t => ({
  id: t.hex().primaryKey(), recipient: t.hex().notNull(), amount: t.bigint().notNull(), completed: t.boolean().notNull(),
  transactionHash: t.hex().notNull(), blockNumber: t.bigint().notNull(),
}));
export const accounting = onchainTable("accounting", t => ({
  id: t.text().primaryKey(), escrowed: t.bigint().notNull(), refundCredits: t.bigint().notNull(), accruedFees: t.bigint().notNull(),
  liabilities: t.bigint().notNull(), refundsPaid: t.bigint().notNull(), feesPaid: t.bigint().notNull(), tokenBalance: t.bigint().notNull(),
}));
export const payment = onchainTable("payment", t => ({
  id: t.text().primaryKey(), kind: t.text().notNull(), account: t.hex().notNull(), amount: t.bigint().notNull(),
  reservationId: t.bigint(), requestId: t.hex(), blockNumber: t.bigint().notNull(), transactionHash: t.hex().notNull(),
}), t => ({ account: index().on(t.account) }));
export const tokenAccount = onchainTable("token_account", t => ({ id: t.hex().primaryKey(), balance: t.bigint().notNull() }));
export const allowance = onchainTable("allowance", t => ({ id: t.text().primaryKey(), owner: t.hex().notNull(), spender: t.hex().notNull(), amount: t.bigint().notNull() }));
export const token = onchainTable("token", t => ({ id: t.hex().primaryKey(), name: t.text().notNull(), symbol: t.text().notNull(), decimals: t.integer().notNull(), totalSupply: t.bigint().notNull() }));
export const eventRecord = onchainTable("event_record", t => ({
  id: t.text().primaryKey(), contract: t.hex().notNull(), name: t.text().notNull(), blockNumber: t.bigint().notNull(), blockHash: t.hex().notNull(),
  transactionHash: t.hex().notNull(), transactionIndex: t.integer().notNull(), logIndex: t.integer().notNull(), timestamp: t.bigint().notNull(), args: t.json().notNull(),
}));
export const checkpoint = onchainTable("checkpoint", t => ({
  id: t.text().primaryKey(), chainId: t.integer().notNull(), blockNumber: t.bigint().notNull(), blockHash: t.hex().notNull(), timestamp: t.bigint().notNull(),
}));
export const equipmentRelations = relations(equipment, ({ one }) => ({ policy: one(policy, { fields: [equipment.policyId], references: [policy.id] }) }));
export const reservationRelations = relations(reservation, ({ one }) => ({
  equipment: one(equipment, { fields: [reservation.itemId], references: [equipment.id] }),
  policy: one(policy, { fields: [reservation.policyId], references: [policy.id] }),
  renter: one(renter, { fields: [reservation.renter], references: [renter.id] }),
}));
