# Agent Runtime Service Guide (`apps/agents`)

`apps/agents` (`@tsp/agents`) is the standalone Agent Runtime service for the Training Set Platform.
It is owned and evolved by coding agents working in the public repository, and will later be
deployed as a dedicated microservice (or ported to Go alongside the BFF).

## Responsibilities

1. **Multi-agent orchestration (`src/runtime.ts`)**:
   - Implements `runAgentTurn(input: AgentTurnInput, llm: AgentModel): Promise<AgentTurnOutput>`
     and `reflectPrompt(input: OptimiserReflectInput, llm: AgentModel): Promise<OptimiserReflectOutput>`
     defined in `@tsp/contracts/agent-api`.
   - Routes user messages starting from the page's active agent (`input.page.agent`), handles
     `front_desk` handoffs to specialist agents, and extracts structured `schema` or `prompt`
     proposals.
2. **Specialist agent presets (`src/presets.ts`)**:
   - `front_desk`: Answers questions about the current page and hands off to specialists.
   - `schema_agent`: Drafts and revises the labeling policy and label fields (`propose_schema`,
     `revise_schema`).
   - `prompt_agent`: Drafts, revises, and explains prompt templates using `{{Key}}` placeholders
     from `@tsp/contracts/catalogue`.
   - `evaluation_agent`: Explains evaluation reports, thresholds, and mix-ups in plain language.
   - `optimiser`: Proposes targeted single-rule improvements during the GEPA-style optimiser loop.
3. **Validation and self-correction**:
   - Validate generated schemas and prompt templates (using `checkTemplate` from
     `@tsp/contracts/template`) before returning proposals so broken placeholders or invalid schema
     shapes are repaired automatically.

## Strict Boundary Rules

- **Stateless and DB-free**: Never import `@tsp/bff` or any database repository here. All project
  state (`task`, `schema`, `history`, `attachedExamples`) arrives via `AgentTurnInput.workspace`,
  and all side effects (messages to append, proposals to save) are returned in `AgentTurnOutput`
  for the BFF to persist.
- **LLM Agnostic & Model Selection**: Call the model exclusively through the `llm: AgentModel`
  parameter:
  - `llm.chat(messages, {model, json, maxOutputTokens, signal})`: returns plain text.
  - `llm.complete(messages, {model, json, maxOutputTokens, signal})`: returns `{text, thinking, model, stopReason, usage}` including reasoning traces.
  - `llm.chatStream(messages, {model, json, maxOutputTokens, signal})`: yields incremental `LlmStreamChunk` events (`delta`, `thinking`, `done`, `error`).
  The full catalog of models supported by the runtime is exported from `@tsp/contracts` as
  `AVAILABLE_LLM_MODELS` (and returned by `llm.models()`):
  - `'gpt-5.6-terra'` (`reasoning` tier, active): highest-quality reasoning model for complex schema design, prompt drafting, and optimiser reflection.
  - `'gpt-5.6-luna'` (`balanced` tier, active): balanced quality and latency model for multi-turn agent tasks and evaluation analysis.
  - `'gpt-5.4'` (`fast` tier, active): fast, lower-cost model suitable for front-desk routing and quick turns.
  - `'gpt-5.5'` (`balanced` tier, currently inactive on gateway; falls back to `'gpt-5.6-terra'`).
  You may freely choose which `LlmModelId` each preset or reasoning step uses in `src/presets.ts`
  and `src/runtime.ts`.
- **English only**: Write all prompts, comments, and tests in English.
- **Testing**: Add unit tests in `src/agents.test.ts` and run `npm test` from `apps/web`.
