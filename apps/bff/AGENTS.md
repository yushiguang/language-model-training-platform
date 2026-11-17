# bff (`@sprint/bff`)

What pages call (`BffContract` in `packages/contracts/src/bff-api.ts`). A thin channel adapter
(deployment readiness spec, 2): it holds no records and makes no business decision.

- `api.ts`: `createBffApi({workflow, identity, appVersion, timeZone})`. For each call it builds the
  `RequestContext` (a new request id, the signed-in user from `identity`, caller `bff`, the app
  version, the user's language when the call carries one, the time zone) and calls the same
  method on `WorkflowContract` with the context first. Also here: the idempotency cache for
  `createVersion`, `scoreVersion` and `startOptimiser` (kept in this bff's closure; a split
  deployment keeps it in a store), `getRuntimeInfo` (the workflow's runtime info plus the user and
  whether Sign out is offered) and `signOut`.
- The signed-in user is asked once; a failed check is asked again on the next call.
- Tests: `api.test.ts` (a real workflow behind the loopback, over the stand-in store).

Test for where logic goes: if a CLI or a tool channel would need it, it belongs in
`@sprint/workflow`; if only the web pages need it, it stays here.

Rules: imports contracts and domain only; the workflow and identity arrive through
`createBffApi`. Its tests may import platform, workflow, catalog and labeling.
