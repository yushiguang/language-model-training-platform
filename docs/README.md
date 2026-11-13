# Documentation Guide and Taxonomy

This directory holds the public product, architecture, and engineering documentation for Sprint.
To keep agent context clean and maintainable, documentation is strictly separated by audience and purpose.

## 1. Versioning Scheme (Semantic Versioning 2.0.0)

Sprint follows [Semantic Versioning 2.0.0](https://semver.org/) (`MAJOR.MINOR.PATCH`):

- **`0.x.y` (MVP / Pre-production)**: Browser-hosted MVP milestones (`0.1.0` through `0.6.x`). Minor bumps may carry breaking internal changes while rapid prototyping is underway.
- **`1.0.0` (First Production Release — Current Target)**: Structured Prompt Tuning workflow, Eval Dataset governance, IDL-ready DDD service boundaries, and production hosting readiness.
- **Post-`1.0.0`**:
  - `MAJOR`: Breaking changes to `@tsp/contracts` service/platform interfaces or incompatible stored document schemas.
  - `MINOR`: Backwards-compatible capabilities, new agent tools, or additive contract fields.
  - `PATCH`: Bug fixes, UI/motion refinements, and copy improvements.

## 2. Separation of Concerns

| Location | Audience | Purpose | Rules |
| :--- | :--- | :--- | :--- |
| `AGENTS.md` and `<workspace>/AGENTS.md` | Coding agents | **Immutable operating guardrails**: workspace boundaries, import rules, sanitization rules, build/test commands, and package ownership. | Keep concise. Never put mutable feature specs or point-in-time review notes here. |
| `docs/architecture.md` & `docs/decisions.md` | All contributors & agents | **Current living architecture and decision log**: how the system works today and why product/technical choices were made. | Update alongside code changes when architecture or product rules change. |
| `docs/ui-gaps.md` | Design & frontend agents | **Design-system parity log**: approved differences between the Unified UI canvas and `apps/web`. | Keep synced with UI changes. |
| `docs/specs/` | External Agent & reviewers | **Actionable release specifications**: self-contained feature, workflow, design-system, and refactoring blueprints ready for implementation. | English only. Purely contract- and product-oriented; zero internal infrastructure details. |
| `docs/handover/integration.md` | Internal & External interface | **Platform adapter contract guide**: documents `@tsp/platform-impl` and transport seams using `@tsp/contracts` interfaces only. | External docs describe interfaces and invariants only, never hosting-platform internals. |
| `/internal/` *(git-ignored)* | Internal team & Internal Agent | **Hosting-platform overlay & internal docs**: adapters, deployment topology, internal frameworks, multi-tenancy/auth integration, and internal roadmaps. | Never committed to this repository; invisible to the public tree and External Agent. |

## 3. Sanitization and Boundary Rules for Public Docs (`docs/**`)

1. **English only**: Every file under `docs/` (and anywhere outside `/internal/`) must be written in English.
2. **Interface-level boundary**: Public docs may reference contracts in `@tsp/contracts` (`Platform`, `BffContract`, service contracts, and extension ports) and public model slugs (`gpt-5.x`), never internal service names, internal frameworks, internal package scopes, or internal URLs.
3. **Contract changes**: Any specification in `docs/specs/` that alters `@tsp/contracts` must explicitly list additive vs. breaking changes so adapter owners can update `/internal/` in lockstep.

## 4. Active Specifications (`docs/specs/`)

- [`docs/specs/2026-11-12-v1.0.0-workflow-and-ddd-spec.md`](specs/2026-11-12-v1.0.0-workflow-and-ddd-spec.md) — **Sprint `v1.0.0` Release Spec**: Prompt Tuning workflow, Structured Prompt model, Eval Dataset balance & governance, Gold Labels unification, standardised AI Suggestions, expanded agent tools, legacy code cleanup, and RPC/IDL-ready DDD refactoring.
- [`docs/specs/2026-11-12-ui-motion-and-design-system-audit.md`](specs/2026-11-12-ui-motion-and-design-system-audit.md) — **UI Motion & Design System Spec**: Frontend motion, async pending/feedback bug audit, and Unified UI design-system refinement proposal for External Agent review.
