# Sprint documentation

This folder is the design portfolio for Sprint: what the product is, how it is designed, how it
is built, and what is specified next. Each fact has one home; other docs link to it.

## Start here

| If you want to know | Read |
| --- | --- |
| What Sprint is for and where it is going | [product/overview.md](product/overview.md) |
| The principles every design is checked against | [product/design-principles.md](product/design-principles.md) |
| How the system is built today (0.x) | [architecture.md](architecture.md) |
| Why a rule is the way it is | [decisions.md](decisions.md) |
| What is being built next (1.0.0) | [specs/](specs/) |
| How the internal build plugs in | [handover/integration.md](handover/integration.md) |

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
│   └── telemetry.md           metric and event conventions
├── architecture.md            apps and packages, model calls, labeling, scores, storage
├── decisions.md               decision log, newest first
├── ui-gaps.md                 open differences between the UI canvas and apps/web
├── specs/                     release specifications ready to implement
├── handover/integration.md    the platform adapter contract
└── tmp/                       one-time documents (reviews, closed lists); not a source of truth
```

## Versioning scheme (Semantic Versioning 2.0.0)

Sprint follows [Semantic Versioning 2.0.0](https://semver.org/) (`MAJOR.MINOR.PATCH`):

- **`0.x.y` (MVP / pre-production)**: browser-hosted MVP milestones. Minor bumps may carry
  breaking internal changes while rapid prototyping is underway.
- **`1.0.0` (first production release, the current target)**: structured Prompt Tuning workflow,
  Eval Dataset governance, IDL-ready DDD service boundaries, and production hosting readiness.
- **After `1.0.0`**:
  - `MAJOR`: breaking changes to `@tsp/contracts` service/platform interfaces or incompatible
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
| `docs/ui-gaps.md` | Design and frontend agents | **Design-system parity log**: open differences between the Unified UI canvas and `apps/web`. | Open items only. Closed items move to `docs/tmp/` or are deleted. |
| `docs/specs/` | External Agent and reviewers | **Actionable release specifications**: self-contained feature, workflow, design-system and refactoring blueprints ready for implementation. | Purely contract- and product-oriented. When a spec is implemented, fold what lasts into the living docs and remove the spec. |
| `docs/handover/integration.md` | Internal and External interface | **Platform adapter contract guide**: `@tsp/platform-impl` and transport seams, using `@tsp/contracts` interfaces only. | Interfaces and invariants only, never hosting-platform internals. |
| `docs/tmp/` | Whoever needs the trail | **One-time documents**: review reports, acceptance rounds, investigations, closed lists. | Dated file names. Never a source of truth. Delete when no longer needed. See [tmp/README.md](tmp/README.md). |
| `/internal/` *(git-ignored)* | Internal team and Internal Agent | **Hosting-platform overlay and internal docs**: adapters, deployment topology, internal frameworks, multi-tenancy/auth integration, internal roadmaps. | Never committed to this repository. |

## Sanitisation and boundary rules for public docs (`docs/**`)

1. **English only**: every file under `docs/` (and anywhere outside `/internal/`) is written in
   English.
2. **Interface-level boundary**: public docs may reference contracts in `@tsp/contracts`
   (`Platform`, `BffContract`, service contracts, and extension ports) and public model slugs
   (`gpt-5.x`), never internal service names, internal frameworks, internal package scopes, or
   internal URLs.
3. **Contract changes**: any specification in `docs/specs/` that alters `@tsp/contracts` must
   explicitly list additive vs. breaking changes so adapter owners can update `/internal/` in
   lockstep.

## Active specifications (`docs/specs/`)

- [`specs/2026-11-12-v1.0.0-workflow-and-ddd-spec.md`](specs/2026-11-12-v1.0.0-workflow-and-ddd-spec.md):
  **Sprint `v1.0.0` release spec**: Prompt Tuning workflow, structured prompt model, Eval Dataset
  balance and governance, Gold Labels unification, standardised AI Suggestions, expanded agent
  tools, legacy code cleanup, and RPC/IDL-ready DDD refactoring.
- [`specs/2026-11-12-ui-motion-and-design-system-audit.md`](specs/2026-11-12-ui-motion-and-design-system-audit.md):
  **UI motion and design system spec**: frontend motion, the async pending/feedback bug audit,
  and the Unified UI design-system refinement proposal.

## Keeping the portfolio in shape

- A design that started as a document outside the repo (a design artifact, a review) is brought
  in here once it is settled, and the outside copy is retired. The UI canvas is the one standing
  exception: screens are drawn there, and [design/ui.md](design/ui.md) describes the system.
- Do not keep dated "as of" paragraphs piling up in a living doc. Rewrite the section so it reads
  as the current truth, and put the date and the reason in [decisions.md](decisions.md).
