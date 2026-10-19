import { ponder, type IndexingFunctionArgs, type EventNames } from "ponder:registry";
import * as schema from "ponder:schema";
import type { Store, Table, Tables, Event } from "../shared/model";
import { apply, lower } from "../shared/project";
import { settings as s } from "../shared/config";

function store(db: any): Store {
  return {
    get: async <K extends Table>(table: K, id: Tables[K]["id"]) => db.find(schema[table], { id }),
    put: async <K extends Table>(table: K, row: Tables[K]) => { await db.insert(schema[table]).values(row).onConflictDoUpdate(row); },
  };
}
ponder.on("MockPaymentToken:setup", async ({ context }) => {
  // Exact immutable metadata from the pinned MockPaymentToken source. No archive state read is needed for replay.
  await context.db.insert(schema.token).values({ id: lower(s.token), name: "kkk", symbol: "dds", decimals: 6, totalSupply: 0n });
});
// Typed registration keeps ABI event names checked by Ponder codegen.
type LogEventNames = Exclude<EventNames, `${string}:setup` | `${string}:block`>;
function handler(name: string) {
  return async ({ event, context }: IndexingFunctionArgs<LogEventNames>) => {
    const e: Event = { id: `${s.chainId}:${event.block.hash}:${event.log.logIndex}`, name, contract: lower(event.log.address),
      blockNumber: event.block.number, blockHash: event.block.hash, timestamp: event.block.timestamp,
      transactionHash: event.transaction.hash, transactionIndex: event.transaction.transactionIndex, logIndex: event.log.logIndex, args: event.args };
    await apply(store(context.db), e, s.escrow);
  };
}
ponder.on("MockPaymentToken:Transfer", handler("Transfer"));
ponder.on("MockPaymentToken:Approval", handler("Approval"));
ponder.on("RentalEscrow:AdminTransferStarted", handler("AdminTransferStarted"));
ponder.on("RentalEscrow:AdminTransferred", handler("AdminTransferred"));
ponder.on("RentalEscrow:StaffUpdated", handler("StaffUpdated"));
ponder.on("RentalEscrow:PolicyCreated", handler("PolicyCreated"));
ponder.on("RentalEscrow:ItemAdded", handler("ItemAdded"));
ponder.on("RentalEscrow:ItemPolicyUpdated", handler("ItemPolicyUpdated"));
ponder.on("RentalEscrow:ItemListingUpdated", handler("ItemListingUpdated"));
ponder.on("RentalEscrow:ItemMetadataUpdated", handler("ItemMetadataUpdated"));
ponder.on("RentalEscrow:ReservationCreated", handler("ReservationCreated"));
ponder.on("RentalEscrow:ReservationCancelled", handler("ReservationCancelled"));
ponder.on("RentalEscrow:ReservationExpired", handler("ReservationExpired"));
ponder.on("RentalEscrow:ItemCheckedOut", handler("ItemCheckedOut"));
ponder.on("RentalEscrow:ItemReturned", handler("ItemReturned"));
ponder.on("RentalEscrow:RefundCredited", handler("RefundCredited"));
ponder.on("RentalEscrow:RefundWithdrawn", handler("RefundWithdrawn"));
ponder.on("RentalEscrow:FeesWithdrawn", handler("FeesWithdrawn"));
const checkpointHandler = async ({ event, context }: IndexingFunctionArgs<"Checkpoint:block">) => {
  await context.db.insert(schema.checkpoint).values({ id: "rental", chainId: s.chainId, blockNumber: event.block.number, blockHash: event.block.hash, timestamp: event.block.timestamp })
    .onConflictDoUpdate({ blockNumber: event.block.number, blockHash: event.block.hash, timestamp: event.block.timestamp });
};
ponder.on("Checkpoint:block", checkpointHandler);
if (s.endBlock !== undefined) ponder.on("Boundary:block", checkpointHandler);
