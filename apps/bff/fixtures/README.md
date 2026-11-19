# Golden BFF fixtures

Each `.json` file here is one case for a bff (`BffContract` in `packages/contracts/src/bff-api.ts`)
and the workflow behind it, as plain JSON: a small world, a sequence of calls, and the result each
call must give. A bff written for another server, in any language, can be held to the same cases
as this repository's bff (`@yushiguang/sprint-bff` over `@yushiguang/sprint-workflow`). They are
part of the acceptance bar of the deployment readiness spec, sections 4.6 and 6, next to the agent
fixtures in `apps/agents/fixtures/`.

## What a file holds

| Field | What it is |
|---|---|
| `name` | The case in one line. |
| `guards` | The guards and behaviours the case holds an implementation to, in words. |
| `world` | What exists before the first call (below). |
| `steps` | The calls, in order (below). |

### The world

| Field | What it is |
|---|---|
| `users` | The signed-in users, by a name the steps use. The first is the default. A user's `organization` is their tenant. |
| `items` | The items the feature port knows, by item id: `type`, `title`, `features`. Any other id is not found. |
| `problems` | Items the platform's item checks leave out, with the reason (`minor_creator`, `not_recommendable`). |
| `builtIn` | The sample data that ships with the platform: `name` and item `ids`. |
| `reply` | The labeling model's reply to every call. |
| `replies` | Replies for calls whose prompt contains `when`; the first match wins. |
| `records` | Records stored before the first call, by collection, as they are. Their ids are fixed. |

There is one model, `A`. Each labeling call costs 0.03 and gives 150 output tokens.

### A step

| Field | What it is |
|---|---|
| `call` | A `BffContract` method. |
| `args` | Its arguments. `$id:N` stands for the id the run gave that name (see below). |
| `as` | The user the call is made as; the default user when left out. |
| `only` | Keep only these parts of the result: dotted paths (`snapshot.counts`, `0.name`); a path ending in `#` is the length of that list or object, and `#` alone is the result's. A missing part is `null`. |
| `expect` | The result, normalized. Left out when the call returns nothing. |
| `expectError` | The call fails, with a message that contains this text. |
| `note` | Why the step is there. |

A step `{"settle": true}` waits until all queued work (imports, taking examples, labeling) has
finished.

## How an implementation passes a case

1. Build the world: the users, a feature port that answers from `items`, `problems` and `builtIn`,
   a model that answers with `reply` and `replies`, and the `records` in the store.
2. Run the steps in order. Results go through a plain JSON round trip, as over HTTP.
3. Normalize each result: walking objects in key order, each generated id (a short lowercase
   prefix, an underscore and 16 letters or digits, such as `pr_0123456789abcdef`; the prefix may
   have two parts) becomes `$id:N`, numbered in the order the run first shows it, and each ISO time
   becomes `$time`. Ids inside longer strings are named too.
4. Each normalized result equals `expect`, or the call fails with a message containing
   `expectError`.

Cases avoid results that depend on random order (a data source shuffles its items once, with a
random seed): they keep counts with `only` instead.

`apps/bff/src/fixtures.test.ts` does this for this repository's bff on every `npm test`.

## Recording

After a change that is meant to change a result, record the fixtures again and read the diff
before committing:

```
RECORD_FIXTURES=1 node --test --experimental-strip-types --no-warnings apps/bff/src/fixtures.test.ts
```

Recording writes each step's `expect` or `expectError` from the run. A new case is a new file with
its world and steps and no expectations; recording fills them in.
