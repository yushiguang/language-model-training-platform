# Ability cases

Each `.json` file here is one thing users ask the helpers, with what a good answer does. The rows
come from the abilities list in issue #39 (`A2`, `T8` and so on); a file is named after its row.
Unlike the golden fixtures in `../fixtures/`, a case holds no model replies: it is run against a
real model, so any agent runtime with any model can be measured on the same cases.

## What a file holds

| Field | What it is |
|---|---|
| `row` | The row of the abilities list. |
| `name` | The case in one line. |
| `request` | The turn as the workflow sends it (`AgentTurnInput`): the user's message, the page with its helper and intent, the workspace with the page view, and the language. |
| `tools` | What each tool answers, by name, whatever its arguments: `{"result": ...}` or `{"error": "..."}`. A tool not listed answers with an error. |
| `expect.calls` | Tools a good answer calls, each at least once. |
| `expect.notCalls` | Tools a good answer never calls. A paid tool (`try_prompt`, `score_version`, `start_optimiser`) is never allowed unless it is in `calls`. |
| `expect.handoffTo` | The helper the turn should end with, when it should hand off. Left out: no handoff. |
| `expect.reply` | What the reply must do, item by item. |

## How a case is scored

- **Tools**, exactly: every tool in `calls` was called, none in `notCalls` was, no paid tool ran
  unasked, and the turn ended with the right helper.
- **Reply**, by a grader model: each item is met, not met, or unsure. A person grades the unsure
  ones.

A case passes when the tools are right and every reply item is met. The run also reports paid
work started unasked (target 0), and tool and model calls, to spot loops.

## Running them

`npm test` checks every case is well formed and that its helpers may call the tools it expects.
To run them against a model, call `runAbilities` from `apps/agents/scripts/run-abilities.ts` with
an `AgentModel` (`packages/contracts/src/platform-api.ts`), from a script of your own:

```ts
import {runAbilities} from './apps/agents/scripts/run-abilities.ts';

await runAbilities({model: myModel, only: ['A2', 'T8'], out: 'report.json'});
```

`grader` grades the replies with another model (the same model when left out), `only` runs some
rows, and `out` writes the results as JSON. It prints one line per case and the totals.
