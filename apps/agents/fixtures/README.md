# Golden agent fixtures

Each `.json` file here is one case for an agent runtime (`AgentRuntimeContract` in
`packages/contracts/src/agent-api.ts`), as plain JSON, so an implementation in any language can be
held to the same cases as this repository's reference runtime (`@sprint/agents`). They are the
acceptance bar of the deployment readiness spec, sections 4.6 and 6.

## What a file holds

| Field | What it is |
|---|---|
| `name` | The case in one line. |
| `guards` | The guards and behaviours the case holds an implementation to, in words. |
| `kind` | `turn` (`runTurn`), `reflect` (`reflectPrompt`) or `improve` (`draftImprovement`). |
| `request` | The request exactly as the workflow sends it, with the caller's `ctx`. |
| `model` | The model's replies, in the order the reference runtime asked for them. |
| `tools` | The tool calls the helpers make, in order: `agent`, `name`, `args`, and the host's answer (`result`, or `error` when the host refused or failed). |
| `expected` | The output. For a turn, tool calls leave out their timing (`ms`). |

## How a runtime passes a case

1. Send `request` to the runtime, with a model that gives the `model` replies in order (whole, or
   as one streamed piece) and a tool host that answers from `tools`.
2. Every tool call must be the next one in `tools` and carry the request's project, turn and caller:
   for a turn, `projectId` is `request.workspace.projectId` and `turnId` is `request.turnId`; for
   `reflect` and `improve`, `projectId` is `request.projectId` and `turnId` is null. `ctx` is
   always `request.ctx`.
3. The output equals `expected`, every model reply and every tool call was used, and for a turn
   each message in `expected.messages` was published to the progress port, in order, under the
   request's project and turn.

`apps/agents/src/fixtures.test.ts` does this for the reference runtime on every `npm test`.

The model replies use the reference runtime's answer protocol (one JSON object per answer, and
`{"tool": {"name", "args"}}` to call a tool). A runtime that talks to its model another way keeps
the request, the tool answers and the expected output, and records its own replies for the same
cases. `modelCalls` names each preset's model by its registry id.

## Recording

`apps/agents/scripts/record-fixtures.ts` holds the cases: the request, replies written for the
case (or the stand-in model's, where a reply is left out) and each tool's answer. Run it after a
change that is meant to change a fixture, and read the diff before committing:

```
node --experimental-strip-types --no-warnings apps/agents/scripts/record-fixtures.ts
```
