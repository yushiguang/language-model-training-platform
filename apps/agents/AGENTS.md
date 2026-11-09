# Agent Runtime Service Guide (`apps/agents`)

`apps/agents` (`@tsp/agents`) is the standalone Agent Runtime service for Sprint, the training set platform.
It is owned and evolved by coding agents working in the public repository, and will later be
deployed as a dedicated microservice (or ported to Go alongside the BFF).

## Responsibilities

1. **Multi-agent orchestration (`src/runtime.ts`)**:
   - Implements `runAgentTurn(input: AgentTurnInput, llm: AgentModel, tools?: AgentToolHost): Promise<AgentTurnOutput>`
     and `reflectPrompt(input: OptimiserReflectInput, llm: AgentModel): Promise<OptimiserReflectOutput>`
     defined in `@tsp/contracts/agent-api`.
   - Routes user messages starting from the page's active agent (`input.page.agent`), handles
     `front_desk` handoffs to specialist agents, and extracts structured `schema` or `prompt`
     proposals.
   - **The page is the agent's workspace.** `input.workspace.pageView` is the page the user is
     on, built by the bff from saved data (never the DOM). Agents answer from it first.
   - **Read tools.** Each preset lists the read tools it may call (`tools` in `src/presets.ts`,
     specs in `TOOL_SPECS`). The agent model has no native function calling, so a tool call is
     an answer `{"tool": {"name", "args"}}`; the runtime runs it through `tools.call(...)` and
     sends `{"tool_result": {...}}` back as the next user message. At most `MAX_TOOL_CALLS` (4)
     calls per turn; a tool not on the preset's list is refused; results are cut at 12,000
     characters. Changes are still proposals in the answer.
   - **Start tools** (`START_TOOLS`: `try_template`, `score_version`, `start_optimiser`) spend
     money and are marked PAID in the prompt. The host runs them at once (no cost limit, no
     approval); the user stops them from the page.
   - The output lists the model calls and the answers that weren't JSON, for metrics.
2. **Specialist agent presets (`src/presets.ts`)**:
   - `front_desk`: Answers questions about the current page and hands off to specialists.
   - `schema_agent`: Drafts and revises the labeling policy and label fields (`propose_schema`,
     `revise_schema`).
   - `prompt_agent`: Drafts, revises, and explains prompt templates using `{{Key}}` placeholders
     from `@tsp/domain`.
   - `evaluation_agent`: Explains evaluation reports, thresholds, and mix-ups in plain language.
   - `optimiser`: Proposes targeted single-rule improvements during the GEPA-style optimiser loop.
3. **Validation**: a handoff goes only to a known specialist with a known intent; anything else
   is ignored and the front desk answers itself. Validating and repairing schemas and templates
   before they are returned (with `checkTemplate` from `@tsp/domain`) is planned.

## Strict Boundary Rules

- **Stateless and storage-free**: imports `@tsp/contracts` and `@tsp/domain` only (the boundary check enforces it). All project
  state (`task`, `schema`, `history`, `attachedExamples`, `pageView`) arrives via
  `AgentTurnInput.workspace`, anything more comes through the read tools the bff lends, and all
  side effects (messages to append, proposals to save) are returned in `AgentTurnOutput` for the
  BFF to persist. In a split deployment the tool host is a callback to the bff's API.
- **Model calls**: only through the `llm: AgentModel` parameter. The bff passes the llm-gateway's
  agent model, which keeps calls under the chat endpoint's QPM/TPM and retries busy replies:
  - `llm.chat(messages, {model, json, maxOutputTokens, signal})`: returns plain text.
  - `llm.complete(messages, {model, json, maxOutputTokens, signal})`: returns `{text, thinking, model, stopReason, usage}` including reasoning traces.
  - `llm.chatStream(messages, {model, json, maxOutputTokens, signal})`: yields incremental `LlmStreamChunk` events (`delta`, `thinking`, `done`, `error`).
  The full catalog of models supported by the runtime is exported from `@tsp/contracts` as
  `AVAILABLE_LLM_MODELS` (and returned by `llm.models()`):
  - `'gpt-5.6-terra'` (`reasoning` tier, active): highest-quality reasoning model for complex schema design, prompt drafting, and optimiser reflection.
  - `'gpt-5.6-luna'` (`balanced` tier, active): balanced quality and latency model for multi-turn agent tasks and evaluation analysis.
  - `'gpt-5.4'` (`fast` tier, active): fast, lower-cost model suitable for front-desk routing and quick turns.
  - `'gpt-5.5'` (`balanced` tier, currently inactive on gateway; falls back to `'gpt-5.6-terra'`).
  Every preset uses `'gpt-5.6-terra'` (decided 2026-11-04: chat needs the smartest model).
  Change a preset's model in `src/presets.ts` only with the product owner's agreement.
- **English only**: Write all prompts, comments, and tests in English.
- **Testing**: unit tests in `src/agents.test.ts`; run `npm test` from the repo root.
- **No framework**: agents are hand-written on purpose; keep it that way unless agreed.
