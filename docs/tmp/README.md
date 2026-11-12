# One-time documents

This folder is for documents that are written once, used once, and then only kept as a trail:
review reports, acceptance rounds, investigations, migration plans, closed gap lists.

Rules:

- Name a file `YYYY-MM-DD-topic.md` (or `YYYY-MM-topic.md` for a span), so its age is plain.
- Nothing here is a source of truth. When a one-time document decides something, the decision
  goes into [../decisions.md](../decisions.md) and the design goes into the living docs
  ([../architecture.md](../architecture.md), [../design/](../design/), [../product/](../product/)).
- Coding agents do not need to read this folder to work on the repo.
- Delete a file when its findings are all closed and nobody needs the trail. Git keeps it.
- The same sanitisation rules apply as everywhere under `docs/`: English only, nothing internal.

| File | What it is |
| --- | --- |
| [2026-11-ui-gaps-history.md](2026-11-ui-gaps-history.md) | Closed UI gap items from 2026-11-06 to 2026-11-12, cut from `docs/ui-gaps.md` |
