# Sprint documentation

This folder is the design portfolio for Sprint: what the product is, how it is designed, how it
is built, and why. Each fact has one home; other docs link to it.

## Start here

| If you want to know | Read |
| --- | --- |
| What Sprint is for and where it is going | [product/overview.md](product/overview.md) |
| The principles every design is checked against | [product/design-principles.md](product/design-principles.md) |
| How the system is built today (1.2) | [architecture.md](architecture.md) |
| The planned server design for the reworked Prompt Tuning project | [design/server.md](design/server.md) |
| Why a rule is the way it is | [decisions.md](decisions.md) |
| Specifications of past releases (history) | [specs/](specs/) |
| How to run Sprint on your own platform | [integration.md](integration.md) |
| How to ask for a change and how it is reviewed | [../CONTRIBUTING.md](../CONTRIBUTING.md) |

## Map

```
docs/
├── README.md                  this map, the versioning scheme and the rules for docs
├── product/
│   ├── overview.md            goal, users, division of work, versions, vocabulary
│   └── design-principles.md   AI-native design and interaction principles
├── design/
│   ├── ui.md                  the Unified UI: shell, look, words, components, Ask AI
│   ├── optimiser.md           Auto Optimise (GEPA) and Improve with AI
│   ├── helpers.md             the helpers in Ask AI: presets, page views, tools, limits
│   ├── server.md              server design: permissions, jobs, storage, config, notifications (in Chinese)
│   └── telemetry.md           metric and event conventions
├── architecture.md            apps and packages, model calls, labeling, scores, storage
├── decisions.md               decision log, newest first
├── ui-gaps.md                 open differences between the UI canvas and apps/web
├── specs/                     past release specifications, kept as history
└── integration.md             the npm packages and the platform adapter contract
```

## Versioning scheme (Semantic Versioning 2.0.0)

Sprint follows [Semantic Versioning 2.0.0](https://semver.org/) (`MAJOR.MINOR.PATCH`):

- **`0.x.y` (MVP / pre-production)**: browser-hosted MVP milestones. Minor bumps may carry
  breaking internal changes while rapid prototyping is underway.
- **`1.0.0` (first production release, the current target)**: structured Prompt Tuning workflow,
  Eval Dataset governance, IDL-ready DDD service boundaries, and production hosting readiness.
- **After `1.0.0`**:
  - `MAJOR`: breaking changes to `@yushiguang/sprint-contracts` service/platform interfaces or incompatible
    stored document schemas.
  - `MINOR`: backwards-compatible capabilities, new agent tools, or additive contract fields.
  - `PATCH`: bug fixes, UI/motion refinements, and copy improvements.

## Where each kind of document goes

| Location | Audience | Purpose | Rules |
| :--- | :--- | :--- | :--- |
| `AGENTS.md` and `<workspace>/AGENTS.md` | Coding agents | **Operating guardrails**: workspace boundaries, import rules, sanitisation rules, build/test commands, package ownership. | Keep concise. Never put feature specs or point-in-time review notes here. |
| `docs/product/` | Everyone | **Why and for whom**: goal, users, division of work between code, helpers and people, principles. | Changes when the product direction changes, not with each feature. |
| `docs/design/` | Designers, contributors, agents | **How a part is designed and why**, with its as-built detail: UI system, Optimiser, helpers, telemetry. | One doc per part. Say at the top which version it describes. Update with the code. |
| `docs/architecture.md` and `docs/decisions.md` | All contributors and agents | **Living architecture and decision log**: how the system works today and why choices were made. | Update alongside code changes when architecture or product rules change. |
| `docs/ui-gaps.md` | Design and frontend agents | **Design-system parity log**: open differences between the Unified UI canvas and `apps/web`. | Open items only. Closed items are deleted (git keeps them). |
| `docs/specs/` | Whoever needs the trail | **Past release specifications** (1.0.0 to the deployment readiness work), written before issues were the way to ask for work. All are built. | History only, never a source of truth. No new specs are added: designs live on their issues (see `CONTRIBUTING.md`). |
| `docs/integration.md` | Anyone deploying Sprint | **Integration guide**: the npm packages, the platform adapters a deployment provides, the build switches and transport seams, using `@yushiguang/sprint-contracts` interfaces only. | Interfaces and invariants only, never a particular platform's internals. |

## Sanitisation and boundary rules for public docs (`docs/**`)

1. **English only**: every file in this repository is written in
   English. Two exceptions: the translation catalogs in `packages/domain/src/locales/`, and design
   docs written for people to review (such as `design/server.md`), which may be in Chinese.
2. **Interface-level boundary**: public docs may reference contracts in `@yushiguang/sprint-contracts`
   (`Platform`, `BffContract`, service contracts, and extension ports) and public model slugs
   (`gpt-5.x`), never a company's service names, frameworks, package scopes or URLs.
3. **Contract changes**: any change that alters `@yushiguang/sprint-contracts` lists additive vs.
   breaking changes, so every deployment can update its adapters with the release that carries it.

## Past specifications (`docs/specs/`, history)

All of these are built; what lasts from them is in the living docs. They are kept as a trail and
are not read to work on the repo.

- [`specs/2026-11-12-v1.0.0-workflow-and-ddd-spec.md`](specs/2026-11-12-v1.0.0-workflow-and-ddd-spec.md):
  **Sprint `v1.0.0` release spec**: Prompt Tuning workflow, structured prompt model, Eval Dataset
  balance and governance, Gold Labels unification, standardised AI Suggestions, expanded agent
  tools, legacy code cleanup, and RPC/IDL-ready DDD refactoring.
- [`specs/2026-11-12-ui-motion-and-design-system-audit.md`](specs/2026-11-12-ui-motion-and-design-system-audit.md):
  **UI motion and design system spec**: frontend motion, the async pending/feedback bug audit,
  and the Unified UI design-system refinement proposal.
- [`specs/2026-11-14-v1.1.0-creator-languages-problem-reports-spec.md`](specs/2026-11-14-v1.1.0-creator-languages-problem-reports-spec.md):
  **Sprint `v1.1.0`**: who created each project, rename in Project Settings, English and Chinese
  with a switch under the avatar, and problem reports any helper can file as a ticket.
- [`specs/2026-11-16-acceptance-refinements-spec.md`](specs/2026-11-16-acceptance-refinements-spec.md):
  **Acceptance pass refinements**: auth session readiness & sign-out, bold avatar/project badges,
  empty initial features, `Prompt Design` section order (`Persona & Task` first), custom
  `RuleGroup[]` with XML compilation, and the `Project Settings` dialog redesign.
- [`specs/2026-11-16-single-label-and-agent-alignment-spec.md`](specs/2026-11-16-single-label-and-agent-alignment-spec.md):
  **Single-label project scope & agent alignment**: one mutually-exclusive label per project (with
  second-review request and multi-source `LabelSource[]` batch-labeling reservation), stacked
  vertical value cards in `Output Labels & Definitions`, custom `<Select>` on `Compare with`,
  `Shift+Enter` chat send shortcut, and full agent routing / multi-line definition / multimodal
  feature prompt alignment.
- [`specs/2026-11-16-workflow-resilience-and-multiselect-spec.md`](specs/2026-11-16-workflow-resilience-and-multiselect-spec.md):
  **Workflow resilience, single-label multi-select, and rebuild guard**: restore `single | multi`
  selection on the project's single label, keep sampling progress mounted through persistence with
  per-example failure skipping, add `ExampleMedia.externalUrl` & iframe `referrerPolicy="origin"`,
  gate auto-scoring on `gold` approval, pass dry-run ties through to full evaluation, and advise
  `Rebuild scores` before editing or optimising when scores are out of date.
- [`specs/2026-11-17-service-deployment-readiness-spec.md`](specs/2026-11-17-service-deployment-readiness-spec.md):
  **Service deployment readiness**: dual topology (in-process here, RPC in the hosting platform's
  composition), a thin BFF with the application logic moved to a separate workflow module, one
  generic job module for all background work, contracts cleaned of signals and callbacks, a
  platform-supplied model registry, and the agent runtime kept as a reference implementation
  behind its framework-neutral contract. No product behaviour change.

## Keeping the portfolio in shape

- A design that started as a document outside the repo (a design artifact, a review) is brought
  in here once it is settled, and the outside copy is retired. The UI canvas is the one standing
  exception: screens are drawn there, and [design/ui.md](design/ui.md) describes the system.
- Do not keep dated "as of" paragraphs piling up in a living doc. Rewrite the section so it reads
  as the current truth, and put the date and the reason in [decisions.md](decisions.md).
