# Roadmap

What contributors are working on now and plan next, so maintainers can see the pace and steer it.
Updated in every pull request that starts, finishes or reorders an item. New work is asked for in
issues (`CONTRIBUTING.md`); an accepted issue lands here with its number.

## Now

- **Server design for the reworked Prompt Tuning project** (#59). Permissions, a job queue with
  per-endpoint limits, bulk storage, a config module and notifications, delivered as the
  numbered pull requests in the issue. The design doc is merged (#60); step 1, the config
  module, is merged (#61); step 2, permissions and tenant isolation, is merged (#63); step 3,
  the job queue with per-key limits and the queue position on pages, is merged (#66); step 4,
  tenant models (managed by tenant admins, read per tenant by the gateway) and limits per tenant
  and endpoint, is merged (#69); step 6, notifications when scoring or Auto Optimise ends, is
  merged (#71); step 7, object storage for feature snapshots and model answers, is merged (#72);
  step 8, sample numbers and label sets, is merged (#82); step 5, the Optimiser as a chain of
  jobs, is merged (#79); step 9, scores from label sets and Rescore, is merged (#86). Every step
  of the plan is merged.
- **Agent abilities** (#39). The user questions and actions the helpers should handle, turned into
  tools, skills and acceptance cases for any agent runtime. Steps 1 and 2 are merged (see Done);
  step 3, action tools, is next, with their cards drawn on the UI design first.

## Next

1. **First package release check.** The 1.2.0 packages are published; tag `v1.2.0` and check
   they install from GitHub Packages with a read-only token.

## Later

- Run an Ask AI turn as a job, so a turn survives its instance stopping (today it runs where it
  was accepted; `docs/architecture.md`, "Known limits").
- Streaming the live reply to the page instead of polling `getAgentLive`.
- Multi-model comparison on one project (one model per project in 1.x).

## Done

- 2026-11-23: scores from label sets and Rescore (#59 step 9): scores are made only once every
  label set is finished and only on their samples, a score records the basis it rests on, and
  out-of-date scores are worked out again by a queued Rescore (#86, #87).
- 2026-11-23: the Optimiser as chained jobs (#59 step 5): the run only computes, each labeling
  step waits in the model's queue as a labeling job of its own and the run goes on when it ends;
  the sweep continues or fails runs left behind; Stop cancels the run's labeling too (#79, #80).
- 2026-11-23: sample numbers and label sets (#59 step 8): fixed sample numbers, a paged sample
  list, label sets with one labeler each (granted edit access and notified), and a label change
  that clears only the gold labels it makes wrong (#82, #83).
- 2026-11-23: object storage (#59 step 7): `ObjectStorePort`; frozen features and model answers
  packed in segment files when the platform has object storage (#72, #74, #77).
- 2026-11-23: tenant models and limits per tenant and endpoint (#59 step 4): tenant admins add,
  change, remove and pick the default model; new projects use the default; the gateway reads
  each tenant's models without a restart and counts limits per tenant (#69, #70).
- 2026-11-22: permissions and tenant isolation (#59 step 2): every project has a tenant; the
  workflow checks the tenant and permission point of every call, agent tool, job and Optimiser
  step; the Optimiser runs as the person who started it (#63, #64, #65).
- 2026-11-22: the config module (#59 step 1, #61).
- 2026-11-19: Agent abilities steps 1 and 2: read tools, the ability cases, and skills (Improve
  with AI is now the Prompt helper's skill `improve_from_mistakes`) (#39, #40).
- 2026-11-19: collaboration rules: five kinds of issue with their own templates, no code before
  a maintainer's go on the issue, one open pull request at a time, evidence on every pull
  request; `docs/tmp/` removed and `docs/specs/` marked as history (#41).
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
