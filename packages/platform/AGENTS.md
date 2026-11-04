# platform (`@tsp/platform`)

- `standins/`: working stand-ins for every hosting-platform runtime (document store in
  `localStorage`, simulated labeling models, scripted agent, local identity and files, the
  made-up examples file). `config.ts` `createPlatform()` assembles them; it is the default target
  of `@tsp/platform-impl`.
- `doc-repo.ts`: `DocRepo`, records by application `id` over `DocRuntime`, used by catalog and
  labeling.

The internal adapters replace `createPlatform()` through `@tsp/platform-impl`; see
`docs/handover/integration.md`. Imports: contracts, domain.
