# Equipment rental trial read indexer

Standalone **Ponder 0.18.2 project at repository root**. This release contains source, executable tests and deployment instructions. It runs a read-only indexer for the public rental trial; it never signs or submits transactions. No hosting, Railway service, contract deployment or private account is provisioned.

The original contracts and reference repository remain unchanged. See [INDEXER.md](INDEXER.md) for ABI provenance, all indexed events, table keys and maintenance boundaries.

| Deployment | Default |
|---|---|
| Chain | Robinhood Chain Testnet, **46630** |
| Keyless RPC | `https://rpc.testnet.chain.robinhood.com` |
| MockPaymentToken | `0x31339619db548257cE09A76f189b0b1932f5c0cd`, start **138710650** |
| RentalEscrow | `0x06135FF9311eCa80a7484444A552f28fFC660F05`, start **138710790** |
| Proxy/factory | Neither contract is a proxy or factory |

Addresses, start blocks and RPC are configurable in [env.example](env.example). Overrides must be actual deployments of the pinned implementations. Starts must include construction and the token mint; starting later produces incomplete state and reconciliation refuses it. One deployment is indexed per process/database schema. Local transaction fixtures support only disposable Anvil chain **31337**, on literal loopback.

## Tools and ordinary installation

Requires Node **>=22.12**, pnpm **10.34.7** and, in production, PostgreSQL. Dependencies are exact direct pins with the committed pnpm lockfile; ordinary pnpm installation downloads the exact lockfile dependencies from the public registry. The oversized generated pnpm store was removed to fit the 8 MiB source-upload limit. **A fresh install now requires network access; the requested fully offline reinstall is not provided by this source-only release.** Keep an operator-managed package mirror/cache if offline installation is required. Node and pnpm themselves are operator-provided tools. There is no pruned runtime archive, bootstrap installer or single-row JSON projection. `pnpm-workspace.yaml` allows only esbuild's dependency build script.

```sh
npm install --global pnpm@10.34.7
pnpm install --frozen-lockfile
pnpm codegen
pnpm typecheck
pnpm test
```

For development, copy `env.example` to a local `.env`, choose the RPC, then run `pnpm dev`. Ponder loads `.env`; standalone `tsx` scripts do not. To run a standalone script with those variables, export them in your shell or use Node's environment-file option, for example:

```sh
node --env-file=.env --import tsx scripts/preflight.ts
node --env-file=.env --import tsx scripts/reconcile.ts snapshot.json
```

Development uses persistent PGlite in `.ponder/pglite` unless a PostgreSQL URL is set. `PGLITE_DIRECTORY` isolates local development databases. Do not let multiple processes open the same PGlite directory. Production `pnpm start` requires PostgreSQL, prioritizes `DATABASE_PRIVATE_URL` over `DATABASE_URL`, checks RPC chain identity and exact deployed runtime code against the pinned build, and listens on **0.0.0.0:$PORT**. Metadata comes from the exact MockPaymentToken source; production preflight verifies its implementation, and reconciliation verifies metadata against storage.

## Deploy with Docker Compose

These are operator instructions; Docker/Compose deployment was **NOT RUN** on the worker.

1. Put this standalone project in its **own new public repository**, clone that repository onto your server, and install Docker Engine with Compose. Keep the reference contracts repository separate.
2. Run `cp env.example .env`. Edit `.env`: set `POSTGRES_PASSWORD` to a strong random **URL-safe** value (a long random hex value works), choose `PONDER_RPC_URL_46630`, and keep the real deployment defaults unless following a real redeployment. Keep `END_BLOCK` empty to follow live state. Do not commit `.env`.
3. Run:

   ```sh
   docker compose up -d --build
   docker compose logs -f indexer
   curl -i http://127.0.0.1:42069/ready
   curl -s http://127.0.0.1:42069/sync
   ```

   `/ready` returns 503 during backfill and 200 after Ponder completes the configured historical range. The container healthcheck allows a **3600-second start period**, then checks every 15 seconds with a 5-second timeout. A container being alive or healthy is not proof of continuing freshness; monitor `/sync` and logs too.
4. The only published port binds to **127.0.0.1** on the host. PostgreSQL has **no host port**. Data persists in the named `pgdata` volume. There are no Docker sockets, privileged services or host-directory mounts. `LOCAL_PORT` can change the loopback port; the internal indexer port stays 42069.
5. Put a TLS reverse proxy with authentication, request limits and query timeouts in front of the indexer before exposing it. Keep `/snapshot` operator-only and protect SQL especially. Do not publish PostgreSQL. A reverse proxy on the host can reach `127.0.0.1:42069`; a proxy in another container must use the Compose service network, not that container's loopback.
6. To update, pull the reviewed release and run `docker compose up -d --build` again. Compose stops the old indexer before starting the new one: **expect downtime while a changed release backfills**. The database volume and prior deployment schemas remain. Ordinary restarts with unchanged source/config resume the same schema.

The Docker image pins Node **22.22.0** and pnpm **10.34.7**, installs from the lockfile including TypeScript, and runs as the unprivileged `node` user. The Compose database image is PostgreSQL **17.7**. The database should be in the same region/host; high database latency hurts indexing.

## Deploy on Railway with PostgreSQL

Railway instructions are **NOT RUN**, and no Railway/cloud account was accessed or provisioned.

1. Publish this standalone source as a new public GitHub repository. In Railway choose **New Project → Deploy from GitHub repo**, select it, and use repository root as Root Directory. Railway detects the root Dockerfile. Leave the start-command override empty; the Dockerfile calls `scripts/start.sh`.
2. In that project select **Create → Database → PostgreSQL**. Place it and the indexer in the same region. On the indexer service's Variables tab, add a variable reference named `DATABASE_PRIVATE_URL` to the PostgreSQL service's **private** connection URL. Use Railway's variable-reference picker; do not paste credentials into Git or use a public database endpoint.
3. Add the non-secret deployment settings from `env.example`: `CHAIN_ID`, RPC/optional websocket, token/escrow addresses and start blocks, `DATABASE_SCHEMA=rental`, `PONDER_VIEWS_SCHEMA=rental`. Leave `END_BLOCK` empty for live indexing. Railway injects `PORT`; **do not override it**. No signing key is requested or used.
4. Set `RAILWAY_HEALTHCHECK_TIMEOUT_SEC=3600`. Under Settings → Deploy set **Healthcheck Path `/ready`**. Traffic should switch only after readiness. If backfill exceeds the platform timeout, resolve RPC throughput/history limits or increase the permitted timeout; do not skip deployment history or switch to `/health` to hide incomplete indexing.
5. Deploy. Inspect build and indexing logs. Once `/ready` is 200, use Settings → Networking → Generate Domain. Check `/sync` and a GraphQL query before sharing it. Add an authenticated/rate-limited gateway for public query access. Keep `/snapshot` private to operators.
6. Source/deployment changes compute a new physical schema. Ponder publishes the stable views only when the new schema is ready. Retain the previous release/schema for rollback. A restart of an unchanged release resumes its prior schema; Railway deployment IDs are deliberately **not** used as a per-boot random schema.

No `railway.json` or `railway.toml` overrides the Dockerfile. Production never falls back to ephemeral PGlite.

## Readiness, sync and provisional data

| Endpoint | Meaning |
|---|---|
| `/health` | Ponder process/server is up; may be incomplete or stale |
| `/ready` | Ponder completed historical indexing for its configured target; does not continuously certify RPC freshness |
| `/sync` | Recorded completed checkpoint **block number/hash/timestamp**, independently observed RPC head number/hash, observation time, signed block lag, RPC error, live/bounded mode |
| `/status` | Ponder's own indexed progress, not an independently observed head |
| `/graphql` | Read-only entity queries, gated by readiness and observed lag/errors |
| `/sql/db` | Ponder's read-only SQL HTTP protocol, gated the same way |
| `/snapshot` | One-statement coherent database snapshot for operators/reconciliation; 503 if no checkpoint or events extend beyond it |
| `/metrics` | Ponder metrics; restrict externally |

`/sync.indexed` is an actual onchain checkpoint row written after all logs in its block, never the RPC head relabeled as indexed progress. Default checkpoint spacing is **100 blocks**, so it is a conservative lower bound; GraphQL may contain more recent event state. `CHECKPOINT_INTERVAL=1` gives every-block checkpoints at higher RPC cost. Bounded runs additionally checkpoint exactly `END_BLOCK`.

Head observations are cached for five seconds. `lag = observedHead.number - indexed.blockNumber`; it can briefly be negative when the indexer advances beyond a cached observation. Errors clear the current head to null rather than inventing progress. `rpcError` describes the independent head probe; detailed backfill/log RPC errors are reported in Ponder logs and metrics even if the head probe succeeds. `/sync` itself may be unavailable if the database/server is down. Alert on request failures, RPC errors, rising lag and a nonadvancing checkpoint even if `/ready` remains 200. GraphQL/SQL require `/ready`, no observed RPC error, and lag within `MAX_SERVING_LAG` (default 200); bounded runs require reaching the exact end block. An outage may remain undetected during the five-second observation cache.

Latest results are **provisional**. Ponder handles canonical rollback within `REORG_WINDOW_SECONDS` (default 180 chain-timestamp seconds, supported range 0–600); neither that setting nor readiness establishes L1 settlement/finality. During reorg detection, stale/orphan data can be visible briefly. Deep reorgs, resets and inconsistent providers require investigation and deliberate replay into a new schema. Do not make irreversible equipment handovers based solely on this trial's index.

Built-in API guards enforce a 64-KiB request body, 16-KiB URL, global 120 requests/minute per process, GraphQL depth 8 / aliases 20 / tokens 2000, and PostgreSQL statement timeout 15 seconds. Limits are resource controls, not a full security boundary; expensive SQL or many live subscriptions can still exhaust resources. Restrict SQL and snapshot access at the gateway; limit concurrent connections, body/response sizes and request duration there. GraphQL pagination is required; never treat the first page as all records. Separate `ponder serve --schema <physical_schema> --hostname 0.0.0.0 --port <port>` replicas can serve heavy read traffic; use the same reviewed source and explicit physical schema and route only after `/ready`.

## Query examples

Amounts and IDs are decimal **strings** in GraphQL/JSON, with bigint/numeric storage. Token amounts are base units, **6 decimals**; never convert them to JavaScript `Number`. Equipment state: 0 Available, 1 Reserved, 2 Rented. Reservation status: 0 None, 1 Reserved, 2 Rented, 3 Cancelled, 4 Expired, 5 Returned. An available quote requires `listed=true` and `state=0`; revalidate the policy ID when submitting a booking through your own client. No transactions are submitted by this repository.

Use POST `/graphql`, for example:

```sh
curl -s http://127.0.0.1:42069/graphql \
  -H 'content-type: application/json' \
  --data '{"query":"{ accounting(id: \"rental\") { liabilities refundsPaid feesPaid tokenBalance } }"}'
```

The following is one real question/query per table. IDs and addresses below are the supplied **public example**. Replace them with actual indexed IDs when using a new deployment. Reservation `renter` is a GraphQL relation; SQL stores its address in the `renter` column.

**`equipment`: What is available and what policy would the next reservation accept?**

```graphql
{ equipments(where: { listed: true, state: 0 }, limit: 20) { items { id metadataURI policyId policy { deposit cancellationFee reservationWindow } } } }
```

**`policy`: What terms belong to policy version 1?**

```graphql
{ policy(id: "1") { id deposit cancellationFee reservationWindow } }
```

**`reservation`: What did reservation 1 accept and what is its status?**

```graphql
{ reservation(id: "1") { id renter { id } itemId status policyId createdAt expiresAt deposit cancellationFee reservationWindow clientRef } }
```

**`renter`: What credit and cumulative deposit/refund payments belong to the trial account?**

```graphql
{ renter(id: "0x0ff6617f72544f60802b72d752da7490c304cdee") { credit depositsPaid refundsPaid } }
```

**`payment`: Which deposits, credits and payments belong to that renter?**

```graphql
{ payments(where: { account: "0x0ff6617f72544f60802b72d752da7490c304cdee" }, limit: 20, orderBy: "blockNumber", orderDirection: "desc") { items { id kind amount reservationId requestId blockNumber transactionHash } pageInfo { hasNextPage endCursor } } }
```

**`staff`: Which staff identities have ever been configured, including revoked staff?**

```graphql
{ staffs(limit: 20) { items { id enabled } } }
```

**`administration`: Who controls the escrow and is a handover pending?**

```graphql
{ administration(id: "rental") { admin pendingAdmin } }
```

**`fee_request`: Was the supplied fee request completed and paid?**

```graphql
{ feeRequest(id: "0xb5d4ba7e1b0d63f8be844a65244059d1f8808692685ecd0fd3778d676e543b78") { completed recipient amount transactionHash blockNumber } }
```

**`accounting`: What is currently owed, already paid and held by escrow?**

```graphql
{ accounting(id: "rental") { escrowed refundCredits accruedFees liabilities refundsPaid feesPaid tokenBalance } }
```

**`token_account`: How much of the fixed supply is back in the trial account?**

```graphql
{ tokenAccount(id: "0x0ff6617f72544f60802b72d752da7490c304cdee") { id balance } }
```

**`allowance`: What amounts were most recently emitted by Approval for each owner/spender?**

```graphql
{ allowances(limit: 20) { items { owner spender amount } } }
```

**`token`: What token units and supply are used?**

```graphql
{ tokens(limit: 5) { items { id name symbol decimals totalSupply } } }
```

**`event_record`: What events and canonical positions explain recent changes?**

```graphql
{ eventRecords(limit: 20, orderBy: "blockNumber", orderDirection: "desc") { items { id name blockNumber blockHash transactionHash transactionIndex logIndex args } pageInfo { hasNextPage endCursor } } }
```

**`checkpoint`: Which completed block anchors a coherent snapshot?**

```graphql
{ checkpoint(id: "rental") { chainId blockNumber blockHash timestamp } }
```

Continue paginated lists with `after: "<endCursor>"` until `hasNextPage=false`. For strict event ordering sort by **blockNumber, transactionIndex, logIndex** in SQL; GraphQL's single-field order plus pagination is useful for browsing but does not itself order tied block positions.

`allowance.amount` is the **last emitted Approval amount**, not a guarantee of current spendable allowance: this OpenZeppelin ERC-20 does not emit Approval when `transferFrom` spends an allowance. Full Approval and Transfer history is retained in `event_record`; a transaction client must read `allowance(owner, spender)` before spending. Metadata URIs are stored as untrusted strings; the indexer never fetches them.

`payment.kind` is DEPOSIT, CREDIT, REFUND or FEE. A CREDIT records an obligation, not a token payout. Refund withdrawals are aggregate pulls and cannot be attributed to one reservation. A missing `feeRequest` means **no indexed successful completion**, not proof that an attempt failed or that its transaction was never sent. Failed/reverted intentions have no contract event and are not indexed. Original reservation policy, deposit, fee, creation/expiry times and clientRef remain after item policy changes or terminal settlement.

SQL over HTTP uses Ponder's `/sql/db?sql=<encoded superjson query>` protocol, not a raw POSTed SQL string. This dependency-free example asks about current liabilities and historical payments:

```sh
node --input-type=module <<'JS'
const query = {json: {
  sql: 'select liabilities::text, refunds_paid::text, fees_paid::text from accounting limit 1',
  params: [], typings: []
}};
const url = 'http://127.0.0.1:42069/sql/db?sql=' + encodeURIComponent(JSON.stringify(query));
console.log(await fetch(url).then(r => r.text()));
JS
```

Direct PostgreSQL uses the stable views schema and **snake_case SQL columns**, for example:

```sql
SELECT e.id, e.metadata_uri, p.deposit, p.cancellation_fee, p.reservation_window
FROM rental.equipment e JOIN rental.policy p ON p.id = e.policy_id
WHERE e.listed AND e.state = 0 ORDER BY e.id LIMIT 20;
SELECT id, status, deposit, cancellation_fee, reservation_window, client_ref
FROM rental.reservation WHERE id = 1;
SELECT * FROM rental.staff ORDER BY id; -- Includes enabled=false revocations.
SELECT * FROM rental.event_record ORDER BY block_number, transaction_index, log_index LIMIT 100;
```

Run all shipped GraphQL examples plus SQL with `API_URL=http://127.0.0.1:42069 pnpm check:queries`. Exact queries are also in [examples/queries.json](examples/queries.json).

## Same-block reconciliation and the public example

Reconciliation is an audit, not a repair. It writes nothing to the database or chain and exits nonzero on mismatch, malformed/noncanonical evidence, missing history or unavailable historical storage. It **never substitutes latest** for a failed historical call.

1. Choose a live coherent checkpoint by fetching `/snapshot`, or set `END_BLOCK=138754466` in a separate deployment to reproduce the supplied example. The physical schema changes when the end block changes. Do not compare that fixed example with a changing latest deployment.
2. Fetch a snapshot:

   ```sh
   curl --fail http://127.0.0.1:42069/snapshot > snapshot.json
   ```

   Export uses one SQL SELECT/MVCC statement for **all audited entity arrays and checkpoint**, casts integers to text before JSON conversion, and rejects a partial checkpoint. It does not assemble separate GraphQL pages across moving blocks. If 503 reports events beyond the last periodic checkpoint, retry after the next checkpoint or use interval 1. For a fixed audit, a bounded deployment makes capture deterministic.
3. Run `pnpm reconcile snapshot.json` with matching exported deployment/RPC settings. Inside Compose, one option is to copy the snapshot into the indexer container and run `docker compose exec indexer pnpm reconcile /tmp/snapshot.json`; the command only reads that file and RPC. An operator can also run the source locally against the exported snapshot.
4. If logs and archive state are available from different providers, set `RECONCILE_STATE_RPC_URL` explicitly. Logs/headers are scanned through `PONDER_RPC_URL_<chainId>`; storage/code use the state provider. **Both must report the expected chain and identical canonical checkpoint hash before and after the audit.** Empty uses the same RPC for both. No silently selected provider or latest-state fallback is used.

The independent audit scans **all escrow logs from the configured deployment boundary** in consecutive ranges (default 500, maximum 1000). It checks metadata/ranges, exact duplicates/conflicts, strict ABI decoding and every log's block hash and transaction position against canonical headers. It discovers staff identities (including revocations), successful fee-request IDs and renter identities independently of the projection; checks membership both ways; sums historical refunds/fees and per-renter payments with bigint; checks storage counts/enumerated policy/item/reservation records, accepted terms, booking references, admin/pending admin, staff state, completed fee results, credits, liabilities, exact token balance/metadata/supply and existing token-account balances. The configured pre-deployment blocks must have no code, and the escrow constructor event must be present. Code must match the pinned non-proxy builds, with the token immutable patched from configuration.

Each request has a configured 15-second default timeout, at most two HTTP 429/503 retries with 200/400-ms backoff; log ranges shrink on failure down to one block. Pages of 1000 or more logs are treated as potentially truncated and split. Audits refuse counts over 100,000 entities rather than silently truncating them. Total scan work grows with history; run large audits off the query-serving path. Ponder also has its own bounded retry/backoff mechanism around indexing RPC calls.

**Trust/completeness limits:** RPC replies are trusted, not cryptographic inclusion proofs. Header/transaction cross-checks do not prove every log was returned. A consistently dishonest provider or silent historical omissions can evade event-only cumulative-payment checks. A second operator's matching closing hash improves anchoring but does not prove completeness. The audit does not certify each event/payment-history row, token-account membership, Approval history/current allowance, donation provenance, off-chain equipment condition, pending/reverted requests or future correctness. Token balance above liabilities is reported as `donationSurplus`, not incorrectly assigned to withdrawable fees. It never repairs records.

The supplied example was actually discovered and checked at **138754466**, hash **`0x198390e8346394fda55e74abb43cce543aff5768667adbf14bfc1c873bf90bad`**. Earlier events were scanned from the real start blocks. Both default RPC and dRPC agreed on that canonical hash. The successful read-only reconciliation reported:

```json
{"ok":true,"blockNumber":"138754466","refundsPaid":"45000000","feesPaid":"5000000","tokenBalance":"0","liabilities":"0","donationSurplus":"0"}
```

One policy, item and cancelled reservation (ID 1), administrator/renter/fee recipient, 6 decimals, snapshotted 50,000,000 deposit / 5,000,000 cancellation fee / 86,400-second window, booking clientRef, completed fee request/transaction and restored fixed supply were checked. All obligations were zero and item 1 was available. [Public snapshot](evidence/public-snapshot.json), [queries](evidence/public-queries.json), [RPC/storage evidence](evidence/public-rpc.json) and [reconciliation](evidence/public-reconcile.json) contain the measurements.

The default RPC served logs and the fixed canonical headers but refused some old state with **historical state unavailable / missing trie node**. dRPC served fixed historical code/storage but its free log API refused old ranges even after shrinking. The publicnode alternative matched chain/hash but refused historical code. The successful audit therefore explicitly used the default endpoint for events and dRPC for archive state. Public endpoints may rate-limit, prune history, load-balance inconsistently or change their free-plan limits. Configure an archive-capable RPC with complete logs for sustained hosting/reconciliation; no key or paid account is bundled. The public example proves only cancellation/refund/fee withdrawal. Checkout/return, expiry, separated roles and failure recovery were exercised separately on disposable local Anvil.

## Restart, rebuild, rollback and data retention

`scripts/deployment.ts` fingerprints the exact indexer/ABI/schema/config/scripts/pnpm-lock source and deployment identity (chain, addresses, starts, optional end, checkpoint/reorg settings). The physical schema is `<DATABASE_SCHEMA prefix>_<24 hex digits>` (max 44 chars). RPC changes and process restarts do not change it; source or deployment changes do. The prefix is operator-settable, **not** a way to remove the deployment fingerprint. Inspect the name with `pnpm exec tsx scripts/deployment.ts` in the release's environment. Never share one physical schema between simultaneous writers.

Ponder's rollback tables/checkpoints and sync cache remain under framework control. There is no custom SQL write, external event queue or manual row repair that bypasses Ponder rollback. Exact log duplicates are normalized by a read-only transport; conflicting duplicates fail. Canonical event keys are `chainId:blockHash:logIndex`. An existing identical event row is a no-op; conflict throws before state changes. Ponder applies a chain's logs in EVM execution order, with checkpoint handlers last in each checkpoint block.

A changed release backfills a distinct schema and only then updates the stable `PONDER_VIEWS_SCHEMA` (default `rental`). Existing data is preserved by default; no startup code drops old schemas. Rebuild intentionally by choosing a new namespace prefix or reviewed release and waiting for `/ready`, then reconcile it. Rollback by restoring the previous image/source **and its deployment settings**, starting its old physical schema and switching API traffic after readiness; the old schema can catch up before its views are republished. Keep backups before changes. A code rollback does not reverse chain transactions.

List and deliberately clean up only after verifying backups, retention and that no serving/rollback deployment needs those schemas:

```sh
docker compose exec indexer pnpm exec ponder db list
# Destructive: drops all Ponder deployments the framework considers inactive.
# Inactive does NOT mean unneeded for rollback or referenced by an external reader.
docker compose exec indexer pnpm exec ponder db prune
```

Do not schedule prune automatically. Review Ponder's list and views first; preserve prior schemas through a rollback window. Never use `docker compose down -v` for an ordinary restart/update.

For a consistent logical backup, run on your deployment host:

```sh
docker compose exec -T postgres pg_dump -U rental -d rental -Fc > rental-backup.dump
```

Use the actual `POSTGRES_DB` if changed. Encrypt/store backups outside the server and test restoration. Stop the indexer before a restore, and restore into a **new empty database** to preserve the old one:

```sh
docker compose stop indexer
docker compose exec postgres createdb -U rental rental_restore
cat rental-backup.dump | docker compose exec -T postgres pg_restore -U rental -d rental_restore --no-owner --exit-on-error
```

Then set `POSTGRES_DB=rental_restore` in local `.env` and recreate services with `docker compose up -d` so the private connection and healthcheck select the restored database. The same deployment fingerprint/schema resumes; wait for `/ready`, inspect lag and reconcile. Keep the old database until validation succeeds. On Railway use the platform/private PostgreSQL backup tooling or `pg_dump`/`pg_restore` through an authorized private connection; restore to a separate database and update the private URL reference. Do not put database URLs or backup contents into this public repository. These backup/restore procedures were **NOT RUN** on the worker.

## Executable checks and actual evidence

Worker commands were run in a complete source copy under `test/scratch/project/` so the protected root `node_modules/` was never modified. This directory is not part of the release. The copy used the same source/ABIs/lockfile and ordinary pnpm installation, with its temporary writable store during development; those earlier offline results describe the pre-repair bundle. See the packaging repair evidence below for current checks.

| Check | Actual result |
|---|---|
| `pnpm install --frozen-lockfile` in a clean copy | PASS (see final checks record) |
| `pnpm codegen` | PASS; committed `ponder-env.d.ts` |
| `pnpm typecheck` | PASS |
| `pnpm test` | PASS; final count in [checks.json](evidence/checks.json) |
| `forge build --root /tmp/rental-reference --cache-path /tmp/rental-forge-cache --out /tmp/rental-build` | PASS; 46 source files, exact solc 0.8.26 |
| `node scripts/extract-abis.mjs /tmp/rental-build --check` | PASS; ABIs, runtime code and fixture bytecode match compiled artifacts |
| `pnpm test:integration` | PASS against newly spawned loopback Anvil 31337 and persistent PGlite; [result](evidence/integration.json) |
| Fixed public backfill from both real deployment starts through 138754466 | PASS; 14 entity tables created, all events applied, `/ready` 200; 30-second uncached run, later replay used Ponder cache |
| `API_URL=http://127.0.0.1:42805 pnpm check:queries` | PASS; all 14 documented GraphQL questions plus SQL HTTP |
| `RECONCILE_STATE_RPC_URL=https://robinhood-testnet.drpc.org pnpm reconcile <captured snapshot>` | PASS at fixed canonical block, independent bounded event scan and historical calls |
| PostgreSQL integration, Docker build/Compose, Railway, backup/restore | **NOT RUN**; no Docker service available; standalone PostgreSQL initialization could not drop UID in this worker. No cloud provisioning attempted. |

Measured tools: Node **24.21.0**, npm **11.19.0**, pnpm **10.34.7**, Ponder **0.18.2**, viem **2.57.7**, Hono **4.13.13**, TypeScript **5.9.3**, tsx **4.20.6**, `@types/node` **24.10.1**; Foundry/anvil **1.8.3** (`cae51ad458f6abb64852b7709eb784352429825d`). Docker's Node 22.22.0 and PostgreSQL 17.7 images were not executed here.

The integration harness needs an installed `anvil` executable, uses only its own fresh loopback ports/processes and unlocked disposable accounts, and rejects nonlocal endpoints/other chain IDs before transaction or fault calls. It deploys exact compiled test fixtures to **31337 only**. It retains only its own scratch data/logs and stops its owned children/proxy on normal completion, errors and SIGINT/SIGTERM. It never faults or transacts on the public chain. Unit tests are offline. To exercise the same harness with a disposable **local** PostgreSQL instance, set `TEST_DATABASE_URL` and run `pnpm test:integration`; only loopback database URLs are accepted, fresh uniquely named schemas are used, and existing data is never deleted. Test schemas/cache are retained for diagnosis and deliberate cleanup.

There are no public-testnet transaction tests, load benchmarks, deep-reorg guarantees, production approval or independent security certification. Check results are reproducible observations, not a certification by the contributor network.

## Packaging repair

The upload rejected the previous generated dependency store (89,578,772 compressed source bytes, limit 8,388,608). Removed only the vendored pnpm cache, its forced offline configuration and Docker copy. Exact dependency declarations, lockfile, application source, fixtures and prior runtime evidence are retained. The Dockerfile and ordinary pnpm commands now install from the registry. This resolves source size but leaves the original network-free installation requirement **UNMET**; no dependency archive or hidden downloader replaces the store. Earlier offline-install evidence applies to the previous bundle, not this repair. Clean registry install, codegen, typecheck and all 23 unit tests passed after this change. The source archive measured about 107 KB, below 8 MiB; even a lossless xz archive of the full store measured 53 MiB. Public RPC and integration checks were not rerun for this packaging-only repair. Current checks are recorded in `evidence/packaging-repair.json`.
