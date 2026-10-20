import { db } from "ponder:api";
import schema from "ponder:schema";
import { client, graphql, sql } from "ponder";
import { settings as s } from "../../shared/config";
import { columns, type Snapshot } from "../../shared/snapshot";
import { rpcClient } from "../../shared/rpc";
import { createApi } from "./app";
import { createServingProbe } from "./probe";

// One probe is shared by /healthz, /sync and the GraphQL/SQL guards. At most one
// observation is in flight; a late result after its deadline is discarded and a
// fresh, in-time observation is required before queries become eligible again.
const probe = createServingProbe({
  readCheckpoint: async () => {
    const [row] = await db.select().from(schema.checkpoint);
    return row === undefined ? null : { id: row.id, chainId: row.chainId, blockNumber: row.blockNumber, blockHash: row.blockHash, timestamp: row.timestamp };
  },
  headClient: timeout => rpcClient({ ...s, timeout }),
  readyUrl: `http://127.0.0.1:${process.env.PORT || "42069"}/ready`,
}, s);

// All arrays and checkpoint come from ONE SELECT statement/MVCC snapshot.
const tableFragments = Object.entries(columns).map(([name, fields]) => {
  const table = (schema as any)[name];
  const pairs = fields.flatMap(field => [sql`${field}::text`, sql`${table[field]}::text`]);
  return sql`${name}::text, (select coalesce(json_agg(json_build_object(${sql.join(pairs, sql`, `)})), '[]'::json) from ${table})`;
});
async function snapshot(): Promise<Snapshot> {
  const result = await db.execute(sql`select json_build_object(${sql.join(tableFragments, sql`, `)}) as tables, (select max(${schema.eventRecord.blockNumber})::text from ${schema.eventRecord}) as "eventMaxBlock"`);
  const row = result.rows[0] as { tables: Snapshot["tables"]; eventMaxBlock: string | null };
  if (!row.tables.checkpoint[0]) throw new Error("No completed block checkpoint yet");
  if (row.eventMaxBlock && BigInt(row.eventMaxBlock) > BigInt(row.tables.checkpoint[0].blockNumber!)) throw new Error("Indexing a partial block: retry snapshot");
  return { version: 1, deployment: { chainId: s.chainId, token: s.token.toLowerCase(), escrow: s.escrow.toLowerCase(), tokenStart: s.tokenStart, escrowStart: s.escrowStart }, ...row };
}

const app = createApi({
  probe,
  snapshot,
  graphql: graphql({ db, schema }, { maxOperationDepth: 8, maxOperationAliases: 20, maxOperationTokens: 2000 }),
  sql: client({ db, schema }),
  endBlock: s.endBlock,
});
export default app;
