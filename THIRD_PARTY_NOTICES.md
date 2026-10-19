# Provenance and licenses

The ABI and compiled bytecode files in `abis/` and `tests/fixtures/` are derived from the MIT-licensed RentalEscrow and MockPaymentToken sources, and their pinned MIT-licensed OpenZeppelin implementation dependencies, in:

https://github.com/identity-md-launches/launch-1988-kkk/tree/6ce8023819f68d2b84f2151b24285af477f4d9c7

Exact compilation/provenance is recorded in `abis/PROVENANCE.json` and `INDEXER.md`. The fixture bytecodes are for disposable local Anvil deployments only. The public deployed contracts are not modified.

Ordinary npm dependencies retain their upstream licenses in installed packages. They are installed with standard pnpm through the committed lockfile; no private runtime archive or module patches are used.
