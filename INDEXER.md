# Maintainer record

The deliverable is a **standalone Ponder 0.18.2 project at repository root**, intended for its own new public repository. This record describes the release's implemented state. It is not an instruction to alter the reference contracts or reuse their old packaging.

## Sources and deployment identity

| Chain/config name | Chain ID | RPC environment/default |
|---|---:|---|
| `rental` | 46630 | `PONDER_RPC_URL_46630`, default `https://rpc.testnet.chain.robinhood.com` |
| `rental` in disposable test mode | 31337 | `PONDER_RPC_URL_31337`, loopback only; actual receipt addresses/starts required |

| Contract | Default address | Inclusive start block | ABI |
|---|---|---:|---|
| MockPaymentToken | `0x31339619db548257cE09A76f189b0b1932f5c0cd` | 138710650 | `abis/MockPaymentToken.ts` |
| RentalEscrow | `0x06135FF9311eCa80a7484444A552f28fFC660F05` | 138710790 | `abis/RentalEscrow.ts` |

Both contracts are non-proxy, non-factory deployments. There are no dynamic child contracts. `CHAIN_ID`, `TOKEN_ADDRESS`, `TOKEN_START_BLOCK`, `ESCROW_ADDRESS`, `ESCROW_START_BLOCK` and `PONDER_RPC_URL_<id>` select one compatible deployment. Defaults are preserved. Optional `END_BLOCK` bounds all sources and adds an exact final checkpoint. Production requires PostgreSQL. See `env.example` for every setting; `TEST_DATABASE_URL` and `API_URL` are test/check tools, not indexer configuration.

Reference repository: https://github.com/identity-md-launches/launch-1988-kkk at **`6ce8023819f68d2b84f2151b24285af477f4d9c7`**. Source files: `src/MockPaymentToken.sol`, `src/RentalEscrow.sol`, and their pinned OpenZeppelin dependencies. Read the reference `indexer/` and `docs/RECONCILIATION-REPAIR.md` only for behavior/tests. This release uses ordinary Ponder, separate tables, public middleware and pnpm packaging. Dependencies use exact pins and the committed standard pnpm lockfile. The generated store was removed after exceeding the 8 MiB upload limit; fresh installation requires registry access. Fully offline installation is an unmet requirement (see README packaging repair). No custom installer or pruned runtime archive is used.

Exact ABI derivation performed:

```sh
curl -fL https://api.github.com/repos/identity-md-launches/launch-1988-kkk/tarball/6ce8023819f68d2b84f2151b24285af477f4d9c7 -o /tmp/rental-reference.tar.gz
mkdir -p /tmp/rental-reference
tar -xzf /tmp/rental-reference.tar.gz -C /tmp/rental-reference --strip-components=1
forge build --root /tmp/rental-reference --cache-path /tmp/rental-forge-cache --out /tmp/rental-build
node scripts/extract-abis.mjs /tmp/rental-build --check
```

The first ABI generation used each artifact's complete `abi` value; the delivered extractor can regenerate or check all ABIs, exact Anvil fixture creation bytecodes and deployed runtime bytecodes. Compilation: solc **0.8.26+commit.8a97fa7a**, optimizer enabled/200 runs, Cancun EVM, no via-IR. `abis/PROVENANCE.json` records exact source, generated ABI, artifact, runtime-module and fixture SHA-256 values. ABIs are full TypeScript `as const` arrays, including constructors/errors/functions. No signatures were inferred from names or prose.

`abis/runtime.ts` preserves exact compiled deployed code and the compiler's immutable offsets. RentalEscrow's sole immutable is its token address, patched at the compiler-reported 32-byte locations for code comparison. The actual fixed public code matched byte-for-byte:

- MockPaymentToken code keccak256: `0x4a434f5008fa14d997462091d49cb70b03acf86db31b22010d4093a5bc87bd71`.
- RentalEscrow code keccak256 with the supplied token: `0xe13dafc2ff386b594ade634e3443d2ca2a6042a3dbf83a3584a71d34f6cab302`.

Production preflight verifies chain, same-block code/immutable identity and escrow token/decimals. Reconciliation checks historical code and pre-start absence as well. The exact token source fixes name `kkk`, symbol `dds` and decimals 6; setup initializes this metadata without requiring deployment-block archive calls. Mint/Transfer events reconstruct supply/balances, and the audit checks metadata/supply against fixed-block storage. These guards intentionally reject other implementations even if their ABI looks similar.

## Tables, keys and writes

One deployment per physical schema; no composite chain prefix is needed on the entity IDs inside that schema. Solidity uint IDs, amounts and timestamps use Ponder bigint; addresses/hashes use hex; mandatory event fields are not nullable. SQL names/columns are snake_case, while TypeScript and GraphQL use camelCase names. Only payment's `reservationId` and `requestId` are nullable because different payment kinds genuinely lack those fields.

| TypeScript / SQL table | Primary key | Contents / writers |
|---|---|---|
| `policy` / `policy` | bigint policy ID | Immutable deposit/fee/window; PolicyCreated |
| `equipment` / `equipment` | bigint item ID | exists, listed, state, current policy, active reservation, metadata; ItemAdded, ItemPolicyUpdated, ItemListingUpdated, ItemMetadataUpdated, ReservationCreated, ItemCheckedOut, ReservationCancelled, ReservationExpired, ItemReturned |
| `reservation` / `reservation` | bigint reservation ID | renter, item, accepted policy/deposit/fee/window, created/expiry, clientRef, status; ReservationCreated and lifecycle terminal/checkout events |
| `renter` / `renter` | renter address | outstanding credit, cumulative depositsPaid/refundsPaid; ReservationCreated, RefundCredited, RefundWithdrawn |
| `staff` / `staff` | account address | latest explicit enabled flag, **including revoked=false rows**; StaffUpdated |
| `administration` / `administration` | `rental` | admin and pendingAdmin; AdminTransferStarted, AdminTransferred |
| `feeRequest` / `fee_request` | bytes32 request ID | permanent successful recipient/amount/completed/transaction/block; FeesWithdrawn |
| `accounting` / `accounting` | `rental` | escrowed, refundCredits, accruedFees, liabilities, cumulative refundsPaid/feesPaid, escrow tokenBalance; reservation settlement, RefundCredited/Withdrawn, FeesWithdrawn, Transfer |
| `payment` / `payment` | canonical event ID | DEPOSIT/CREDIT/REFUND/FEE, account, exact amount, optional booking/request ID, block/transaction; ReservationCreated, RefundCredited/Withdrawn, FeesWithdrawn |
| `tokenAccount` / `token_account` | account address | Transfer-derived balance (including retained zero balances); Transfer |
| `allowance` / `allowance` | `owner:spender` addresses | latest **emitted** Approval amount, not current storage allowance; Approval |
| `token` / `token` | token address | exact source metadata and Transfer-derived supply; setup, Transfer mint/burn |
| `eventRecord` / `event_record` | `chainId:blockHash:logIndex` | contract/event name, full decoded arguments and ordered canonical block/transaction/log metadata; **all 18 ABI events** |
| `checkpoint` / `checkpoint` | `rental` | completed end-of-block chain ID, number/hash/timestamp; periodic Checkpoint:block (default every 100 blocks), exact Boundary:block on finite end |

GraphQL relations: equipment→policy; reservation→equipment, policy and renter. GraphQL `reservation.renter` is a relation; direct SQL/snapshots retain the scalar address column. Availability, renter/reference and payment-account indexes support common reads. No opaque whole-projection JSON row exists. JSON is used only for decoded event arguments and the exported, read-only snapshot.

## Event coverage and ordering

Every event present in the generated ABIs has an explicit `ponder.on` registration:

| Contract | Event | Projection effect beyond immutable event history |
|---|---|---|
| MockPaymentToken | Transfer | account balances, totalSupply, actual escrow token balance, donations/surplus |
| MockPaymentToken | Approval | last emitted owner/spender approval |
| RentalEscrow | AdminTransferStarted | pending administrator (zero means cancellation as defined by the contract) |
| RentalEscrow | AdminTransferred | administrator and cleared pending administrator; includes constructor |
| RentalEscrow | StaffUpdated | explicit grant/revocation |
| RentalEscrow | PolicyCreated | new immutable policy |
| RentalEscrow | ItemAdded | listed available equipment |
| RentalEscrow | ItemPolicyUpdated | current item quote only; accepted reservation terms stay unchanged |
| RentalEscrow | ItemListingUpdated | listing availability flag |
| RentalEscrow | ItemMetadataUpdated | current untrusted metadata URI |
| RentalEscrow | ReservationCreated | accepted terms, booking reference, reservation/item state, deposit obligation/payment |
| RentalEscrow | ReservationCancelled | Cancelled status, release item, remove escrowed deposit, accrue fee |
| RentalEscrow | ReservationExpired | Expired status, release item, remove escrowed deposit, accrue fee; caller retained in history |
| RentalEscrow | ItemCheckedOut | Rented status/item state; staff retained in history |
| RentalEscrow | ItemReturned | Returned status, release item, remove escrowed deposit; staff/refund retained in history |
| RentalEscrow | RefundCredited | only source of credit increases and CREDIT payment records |
| RentalEscrow | RefundWithdrawn | reduce outstanding credit, increment cumulative paid refunds; aggregate payout |
| RentalEscrow | FeesWithdrawn | completed request, reduce accrued fees, increment cumulative paid fees |

**Intentionally omitted ABI events: none.** Constructors/functions/errors are ABI entries, not additional events. Reverted attempts, failed withdrawals, matching/conflicting retry reverts and pending intentions emit no successful logs and are outside event indexing. Native gas costs, unrelated contracts, off-chain rental operations, metadata fetching and browser UI are intentionally outside this task. Approval-spending changes with no Approval event cannot be inferred from the token event stream; this limitation is documented rather than mislabeled as current allowance.

A chain's events are applied in EVM order. Ponder orders block callbacks after logs; periodic checkpoints therefore anchor complete blocks. Exact raw RPC duplicate logs are normalized before Ponder validates them; conflicting same-position logs fail. The reducer separately verifies duplicate canonical event records before doing any arithmetic. Credits are incremented **only by RefundCredited**, not a second time from cancel/expiry/return's refund arguments. Payments are incremented only from successful payout events, with token Transfers independently tracking balance. No external writes bypass Ponder's supported rollback.

## Reconciliation design

`GET /snapshot` emits one SQL/MVCC statement containing all relevant entity arrays, completed checkpoint and maximum projected event block; integer values are text before JSON serialization. It refuses capture if events extend beyond the checkpoint. This prevents a moving GraphQL-page collection from masquerading as a coherent historical snapshot.

`shared/reconcile.ts` is independent of projection/reducer/event-history records when discovering expected identities and payment sums. It scans all canonical escrow logs from the real start, independently derives expected staff including revocations, fee requests and renters/per-renter payments, and compares membership both ways. It also enumerates count-based policy/item/reservation IDs from chain storage rather than accepting only local row keys. All storage/code calls use the captured block; event ranges use the same fixed end. Log metadata, strict decoding, block hashes, transaction positions, constructor history, accepted terms, clientRefs, credits/accounting, historical payouts, exact balances and donation surplus are checked. Separate state RPC is optional and explicit; both providers must agree on chain/closing block before/after. There is no repair, latest fallback or success on unavailable history.

Per-request timeout/range/retry limits and the 100,000-entity audit ceiling are in README. RPC completeness remains a trust assumption: no receipt-trie proofs, exhaustive history-row validation, token-account membership proof, donation attribution or failed-intent reconstruction is claimed. Latest results remain provisional; the 180-second default Ponder rollback window is not a finality guarantee.

## Deployment and maintenance

- `scripts/start.sh`: require private PostgreSQL URL, compute deterministic physical schema, read-only exact-code preflight, `ponder start --schema ... --views-schema rental --hostname 0.0.0.0 --port "$PORT"`.
- `scripts/deployment.ts` / `scripts/build-id.mjs`: source plus deployment fingerprint; same release/config resumes, changed source/deployment gets a distinct schema. Prefix configurable; fingerprint cannot be bypassed with an address change.
- Dockerfile: ordinary frozen-lockfile install on Node 22.22.0, build/typecheck, unprivileged runtime.
- Compose: internal PostgreSQL with named volume; only indexer published on `127.0.0.1`; readiness healthcheck/start period 3600 seconds. No broad mounts, sockets or privileged containers.
- `/healthz`: version-1 `ready`/`catching_up`/`unavailable` eligibility response with safe reason codes, bigint-safe strings and `Cache-Control: no-store`. A bounded, single-flight checkpoint/RPC/native-readiness observation (`src/api/probe.ts`, routes in `src/api/app.ts`) is shared exactly with `/graphql`, `/sql/*` and `/sync`; it never exposes dependency exception text or endpoint/credential values. Each dependency is reported by its own outcome at the deadline; a probe that settles after its deadline is discarded and a fresh in-time probe is required; cached results are aged from probe start (`HEALTH_CACHE_MS`). Native `/ready` 503 is `catching_up`, any other non-200 is `unavailable` (`readiness_unexpected_response`). `/sync.rpcError` is a safe code (`rpc_unavailable`/`rpc_timeout`/`rpc_wrong_chain`). Live mode permits `MAX_SERVING_LAG` (default 200); bounded mode requires `END_BLOCK` even with a newer live head. This is freshness/dependency evidence, not finality/capacity/future-availability assurance.
- `/graphql` and `/sql/*`: official public Ponder middleware; shared health eligibility gating plus existing query limits. `/sync` separately distinguishes completed checkpoint from observed head and errors. Snapshot is operator-only at the gateway.
- Railway: root Dockerfile, platform port/interface, private PostgreSQL, `/ready` and 3600-second timeout; instructions only, **NOT RUN**.
- Retention: old schemas preserved by default, no automatic prune. README documents separate-release rebuild/rollback, backup into a new database and destructive deliberate cleanup.

Changing existing table names/types or reducer semantics changes the source fingerprint and requires a new backfill; preserve the old schema and API consumers while reviewing migrations. Never reuse the reference's old vendored runtime or replace the entity model with one JSON row.

## Verification record

See `evidence/checks.json` for final measured versions/commands/results and SHA-256 source manifest, and README for executable commands/known limits. Required clean install, codegen, typecheck, unit tests and disposable Anvil integration ran locally. Integration covers checkout/return, expiry, policy changes after acceptance, explicit revocation, duplicate logs, successful credits/payments, restart with persistent database, local-only outage/catch-up, short reorg/orphan removal and independent fresh replay. Real CLI corruptions must fail for missing/extra fee/staff, changed historical payments, accepted terms, credits, liabilities and token balance. Unit RPC faults cover wrong chain, code, noncanonical/changing blocks, transaction disagreement, malformed/unavailable history and conflicting duplicates. Valid history passes.

Actual public scan: inclusive starts above through **138754466**, hash `0x198390e8346394fda55e74abb43cce543aff5768667adbf14bfc1c873bf90bad`. Ponder created 14 entity tables, applied all observed events, and reached `/ready` 200. All documented table queries and SQL HTTP were executed. Same-block reconciliation passed using default public logs plus explicitly selected dRPC historical storage, both independently anchored before/after. The snapshot shows one policy/item/cancelled reservation; refundsPaid 45,000,000, feesPaid 5,000,000, obligations/balance/surplus zero, restored supply, retained original terms, clientRef and completed fee request/transaction. See the retained public evidence JSON.

PostgreSQL integration, Docker/Compose, Railway and backup/restore were **NOT RUN**. This worker has no Docker service; an attempted temporary PostgreSQL initialization could not drop UID. The executable harness supports a requester-run disposable loopback PostgreSQL URL. No public-chain transactions/faults, paid services, private systems, tunnels or cloud accounts were used. There is no claim of production approval or independent certification.
