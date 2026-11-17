# Contributing to Sprint

Sprint is developed in the open. Maintainers decide what gets built and what gets merged;
contributors (people or coding agents) do the work in pull requests. Everything happens on GitHub:
issues for asking, pull requests for changing, and review comments for deciding.

## For maintainers: asking for work

Open one **issue** per piece of work. A contributor picks it up and opens one pull request for it.

**A requirement or design change.** Say:
- what is needed and why (the user or system problem, not only the solution);
- how to know it is done (what a person sees, or what a test checks);
- which contracts it touches, if you know, and whether old data or old clients must keep working;
- what is out of scope.

Title a change to `packages/contracts` `Contract change: <what>`. Say whether it is additive (a new
optional field or method) or breaking, and for a breaking change what every deployment's adapters
must do.

**A bug.** Say:
- the steps to reproduce, from a fresh project when you can;
- what you expected and what happened;
- the version or commit, the page, and any request ids or ticket ids from a problem report.

**Larger designs.** Write the whole design in the issue, or in several issues that link each other.
Do not commit specifications to `docs/`: the contributor writes the accepted design into the living
docs (`docs/architecture.md`, `docs/design/`, `docs/decisions.md`) in the pull request that builds it.

## For maintainers: reviewing and merging

- Review on the pull request. Each comment is either a change you need or a question; say which
  ones are optional. The contributor answers every comment and pushes the fixes to the same pull
  request.
- A pull request is ready to merge when its checks are green, it has no conflict, and you approve.
- Only maintainers merge. A contributor never merges its own pull request.
- Releases: push a tag `v<version>` (or run the `Release packages` workflow with a version) to
  publish the npm packages (see `docs/integration.md`).

## For contributors: doing the work

- **One issue, one branch, one pull request.** Name the branch `<type>/<short-kebab-topic>`
  (`feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `release`). Review fixes and follow-ups are
  new commits on the same pull request; never open a pull request on top of another open one.
  Work that needs an unmerged pull request waits for it, or goes into it when it is the same topic.
- **Say what the pull request does.** Link the issue (`Closes #<n>`). Describe what changed, the
  contract impact (none, additive or breaking, and what adapters must do), and how it was verified.
- **Check before asking for review:** `npm run check` and `npm run build`; for changes to labeling,
  the workflow, the bff or pages, also the browser check (`node apps/web/scripts/e2e-check.cjs`
  against a served build); for changes to what a package exports, `npm run check:packages`.
- **Keep the roadmap current.** `ROADMAP.md` lists what is in progress and what comes next;
  update it in the pull request that starts, finishes or reorders an item.
- **Keep the docs true.** Update the living docs in the same pull request when behaviour,
  architecture or a product rule changes. Record why in `docs/decisions.md`.
- The rules for the code itself (boundaries, languages, telemetry) are in `AGENTS.md`.

## The repository is public

Issues, comments, pull requests and commits are public. Never write keys, tokens, internal URLs or
hostnames, company product or service names, internal package scopes, or real user data. Describe
a need in general terms ("a key-value store with expiry", "a document service the user's links
point to"). Everything is written in English; the translation catalogs in
`packages/domain/src/locales/` are the one exception.
