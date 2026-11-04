# domain (`@tsp/domain`)

Pure rules shared by every app: no I/O, no side effects, deterministic.

`template.ts` (placeholders, checks, rendering), `labels.ts` (answer parsing, settings hash,
evaluation context id, token estimate), `metrics.ts`, `gates.ts`, `versions.ts`, `workflow.ts`
(next-step advice, estimates), `catalogue.ts` (feature keys), `drafts.ts`, `ids.ts`.

Imports: contracts only. Tests: `core.test.ts`.
