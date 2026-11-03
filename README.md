# Language model training platform

A platform where PMs and operations staff produce task models (teacher-to-student distillation).
The MVP (end of 2026) covers training set production only: a fixed-workflow website with agents
built into each step.

- `web/`: the MVP web app (Next.js static export + Astryx). See [web/README.md](web/README.md).
- `db/schema.sql`: the app's Postgres schema (generated from `web/src/data/schema.ts`).
- `docs/architecture.md`: map of the code.
- `docs/handover/integration.md`: how to connect the app to the hosting platform's runtimes.
