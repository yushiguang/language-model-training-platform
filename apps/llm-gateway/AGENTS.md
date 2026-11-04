# llm-gateway (`@tsp/llm-gateway`)

Every model call goes through here: labeling calls (`label`) and agent chat (`agentModel()`).
Contract: `LlmGatewayContract` in `packages/contracts/src/gateway-api.ts`.

- `registry.ts`: registered endpoints from the platform, plus assumed limits per model for
  anything not registered. Assumed values are conservative and marked `assumed`.
- `limiter.ts`: per endpoint, a 60 s sliding window for QPM and TPM, a cap on calls in flight and a
  FIFO queue. Calls wait; they are never sent over the limit. Halves its rate after a 429.
- `gateway.ts`: picks the endpoint (labeling by slot A/B; chat by model, else an active reasoning
  endpoint), estimates tokens, retries busy/server/timeout errors (2, 4, 8, 16 s), and corrects the
  token count with real usage. Reasoning tokens count toward TPM.

Rules: stateless apart from the in-memory limiter; no storage; no knowledge of tasks or projects.
Per-example failure handling belongs to labeling, not here. Imports: contracts, domain.
Tests: `gateway.test.ts` (fake clock, no real waiting).
