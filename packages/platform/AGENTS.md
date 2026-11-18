# platform (`@yushiguang/sprint-platform`)

- `standins/`: working stand-ins for every hosting-platform runtime (document store in
  `localStorage`, simulated labeling models, scripted agent, local identity and files, the
  made-up examples file). `config.ts` `createPlatform()` assembles them; it is the default target
  of `@yushiguang/sprint-platform-impl`.
- `doc-repo.ts`: `DocRepo`, records by application `id` over `DocRuntime`, used by catalog and
  labeling.

A deployment replaces `createPlatform()` with its own adapters through
`@yushiguang/sprint-platform-impl`, or composes the published packages itself; see `docs/integration.md`. Imports: contracts, domain.
