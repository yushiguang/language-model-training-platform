# Language model training platform

A platform where PMs and operations staff produce task models (teacher-to-student distillation).
Version 1.0.0 covers prompt tuning: a fixed-workflow website with helpers built into each step
(Prompt Design, Eval Dataset, Gold Labels, Prompt Tuning). The result is a labeling prompt that
passes the project's checks.

```bash
npm ci
npm run dev        # http://localhost:3000, on the stand-in services
npm run check      # typecheck, unit tests, boundary check
npm run build      # static site in apps/web/out/
```

- [AGENTS.md](AGENTS.md): rules and layout for anyone (person or coding agent) changing this repo.
- [docs/README.md](docs/README.md): the design portfolio and where each kind of document goes.
- [docs/product/overview.md](docs/product/overview.md): what the product is for and where it is going.
- [docs/architecture.md](docs/architecture.md): the apps, how labeling runs, where each rule lives.
- [ROADMAP.md](ROADMAP.md): what is being worked on now and next.
- [CONTRIBUTING.md](CONTRIBUTING.md): how to ask for a change, report a bug, and how pull requests are reviewed and merged.
- [docs/integration.md](docs/integration.md): running Sprint on your own platform: the npm packages, the adapters a deployment provides, and how.
