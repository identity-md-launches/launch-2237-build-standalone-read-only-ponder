import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const base = process.env.API_URL || "http://127.0.0.1:42069";
const queries = JSON.parse(await readFile("examples/queries.json", "utf8")) as { table: string; query: string }[];
const results = [];
for (const { table, query } of queries) {
  const response = await fetch(`${base}/graphql`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }), signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200, table);
  const body = await response.json() as any;
  assert.equal(body.errors, undefined, `${table}: ${JSON.stringify(body.errors)}`);
  assert.ok(body.data, table); results.push({ table, result: body.data });
}
// Ponder's SQL HTTP wire format uses superjson. With plain string/array values the envelope is just {json: ...}.
const query = { json: { sql: 'select "liabilities"::text, "refunds_paid"::text, "fees_paid"::text from "accounting" limit 1', params: [], typings: [] } };
const sql = await fetch(`${base}/sql/db?sql=${encodeURIComponent(JSON.stringify(query))}`, { signal: AbortSignal.timeout(15000) });
assert.equal(sql.status, 200, await sql.text().then(t => t.slice(0, 200)));
const sqlAgain = await fetch(`${base}/sql/db?sql=${encodeURIComponent(JSON.stringify(query))}`).then(r => r.json());
results.push({ table: "SQL read-only example", result: sqlAgain });
console.log(JSON.stringify({ ok: true, results }, null, 2));
