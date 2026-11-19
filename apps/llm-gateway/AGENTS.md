# llm-gateway (`@yushiguang/sprint-llm-gateway`)

Every model call goes through here: labeling calls (`label`) and agent chat (`agentModel()`).
Contract: `LlmGatewayContract` in `packages/contracts/src/gateway-api.ts`.

- `registry.ts`: registered endpoints from the platform, plus assumed limits per model for
  anything not registered. Assumed values are conservative and marked `assumed`.
- `limiter.ts`: per endpoint, a 60 s sliding window for QPM and TPM, a cap on calls in flight and a
  FIFO queue, counted in a `LimiterStorePort` (spec 5) that every process may share. Calls wait;
  they are never sent over the limit. Halves its rate after a 429 and holds calls, in every
  process, for the time asked. A permit's slot is leased (60 s) and renewed while the call runs;
  a waiter refreshes its ticket each time it asks (every 250 ms at most) and wakes at once when a
  slot in this process frees up; an aborted waiter lets the next one go.
- `gateway.ts`: picks the endpoint (labeling by endpoint id; chat by registry model id, else an
  active reasoning endpoint), fits the options to the model's capabilities, runs each try under
  its `timeoutMs`, estimates tokens, retries busy/server/timeout errors (2, 4, 8, 16 s), and corrects the
  token count with real usage. Reasoning tokens count toward TPM. On a 429 the limiter slows down
  before the slot is given back (also on the last try), so no queued call goes out during the
  hold. `chatStream` retries the same way until its first chunk, never after; its slot is
  released in a `finally`, so a consumer that throws on an error chunk or stops reading frees it too.
- Stopping: `label` takes an optional `requestId`; `cancel(requestId)` aborts every call under it
  (a labeling run shares one id) and stops calls that start under it later (kept for 60 s). The
  abort signal stays inside the gateway and goes to the platform's `ChatRequest`.

Rules: no state but the limiter's, which lives in the injected store (`createGateway` takes
`limiterStore`, or the platform's); no knowledge of tasks or projects. Per-example failure
handling belongs to labeling, not here. Imports: contracts, domain; tests also platform.
Tests: `gateway.test.ts`, including several limiters on one store (aggregate QPM, TPM and calls
in flight, a shared hold, lease expiry of a dead process, renewal, FIFO across instances).
