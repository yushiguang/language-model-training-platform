# Language model training platform

A platform where PMs and operations staff produce task models (teacher-to-student distillation).
The MVP covers training set production: a fixed-workflow website with specialist agents built into
each step (Setup, Dataset, Gold Labels, Prompt Engineering, Training Set).

```bash
npm ci
npm run dev        # http://localhost:3000, on the stand-in services
npm run check      # typecheck, unit tests, boundary check
npm run build      # static site in apps/web/out/
```

- [AGENTS.md](AGENTS.md): rules and layout for anyone (person or coding agent) changing this repo.
- [docs/architecture.md](docs/architecture.md): the eight apps, how labeling runs, where each rule lives.
- [docs/handover/integration.md](docs/handover/integration.md): what the internal build replaces, and how.
