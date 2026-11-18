# Roadmap

What contributors are working on now and plan next, so maintainers can see the pace and steer it.
Updated in every pull request that starts, finishes or reorders an item. New work is asked for in
issues (`CONTRIBUTING.md`); an accepted issue lands here with its number.

## Now

- Upload labels as its own action on Gold Labels (#31).
- Fixes from the review of the deployment readiness work (#9), as review comments arrive.

## Next

1. **First package release.** Tag `v1.2.0` (the packages are in main since #23); check they install from
   GitHub Packages with a read-only token.
2. **Datasets from the teams' own data**, in this order, one pull request each: tenant data
   sources imported from item-id files (#29); cutting datasets from a source version without
   overlaps (#30); frozen dataset snapshots in the document store (#32); warehouse tables as a source
   (#33). New screens are drawn in the UI design before they are built.
3. **BFF golden fixtures.** The same plain-JSON cases as the agent fixtures, for `BffContract`
   on the merged contract (request, stand-in data, expected result), so a server-side bff can be
   held to them.
4. **Agent abilities.** The user questions and actions the helpers should handle, turned into
   tools, skills and acceptance cases for any agent runtime. Improve with AI becomes a Prompt
   helper skill here. Needs the maintainers' list of abilities as an issue.

## Later

- Run an Ask AI turn as a job, so a turn survives its instance stopping (today it runs where it
  was accepted; `docs/architecture.md`, "Known limits").
- Streaming the live reply to the page instead of polling `getAgentLive`.
- Multi-model comparison on one project (one model per project in 1.x).

## Done

- 2026-11-18: contribution guide and npm packages on GitHub Packages, with fixes for #24 to #28
  (#23).
- 2026-11-17: deployment readiness (#9): workflow module and thin bff, job module, contracts
  without signals, model registry and shared limiter, agent tool context with guards in the tool
  host, golden agent fixtures.
