# Roadmap

What contributors are working on now and plan next, so maintainers can see the pace and steer it.
Updated in every pull request that starts, finishes or reorders an item. New work is asked for in
issues (`CONTRIBUTING.md`); an accepted issue lands here with its number.

## Now

- **Agent abilities** (#39). The user questions and actions the helpers should handle, turned into
  tools, skills and acceptance cases for any agent runtime. Step 1, read tools and the ability
  cases, is in review; then skills (Improve with AI becomes the Prompt helper's skill), then
  action tools with cards drawn on the UI design first.

## Next

1. **First package release check.** The 1.2.0 packages are published; tag `v1.2.0` and check
   they install from GitHub Packages with a read-only token.

## Later

- Run an Ask AI turn as a job, so a turn survives its instance stopping (today it runs where it
  was accepted; `docs/architecture.md`, "Known limits").
- Streaming the live reply to the page instead of polling `getAgentLive`.
- Multi-model comparison on one project (one model per project in 1.x).

## Done

- 2026-11-19: golden BFF fixtures: plain-JSON call sequences for `BffContract` over a small
  world, replayed on every test run; a gold label is now checked against the project and the
  label (#38).
- 2026-11-18: frozen dataset snapshots: one features document per example, read by id in
  batches; items left out by the checks are counted (#32, #36).
- 2026-11-18: Data Source: tenant data sources from item-id files, and datasets cut from them
  without overlaps (#29, #30, #35).
- 2026-11-18: 1.2.0 packages published to GitHub Packages.
- 2026-11-18: Upload labels as its own action on Gold Labels (#31, #34).
- 2026-11-18: contribution guide and npm packages on GitHub Packages, with fixes for #24 to #28
  (#23).
- 2026-11-17: deployment readiness (#9): workflow module and thin bff, job module, contracts
  without signals, model registry and shared limiter, agent tool context with guards in the tool
  host, golden agent fixtures.

## Not planned

- Warehouse tables as a data source (#33): skipped on 2026-11-19. The design stays on the issue.
