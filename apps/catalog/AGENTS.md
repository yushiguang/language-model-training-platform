# catalog (`@tsp/catalog`)

The product records: projects, setup versions, dataset snapshots, examples, gold labels, prompt
versions (each holding its structured prompt), eval reports, optimiser runs, approvals, chat, proposals, audit log.
Contract: `CatalogContract` in `packages/contracts/src/catalog-api.ts` (`CatalogRecords` lists the
collections and their types).

- Writes are partial (`patch`, `patchMany`) and may use `DocFieldValue` operators, so two writers
  never overwrite each other's fields.
- `createPromptVersion` and `createSetupVersion` assign the version number from what is stored;
  callers never send one.
- `findByIds` reads in chunks of 30 (`in` filter limit).

Rules: CRUD only, no workflow logic. Imports: contracts, domain, platform. Tests: `catalog.test.ts`.
