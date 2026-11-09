# Acceptance feedback, 2026-11-09 (for the External Agent)

Source: a hands-on acceptance pass over sprint-dev v6 with the 90-example pilot dataset
(project "video", through the first prompt's automatic labeling). Owner split decided by the
internal agent: item 11 is already fixed internally (it is the media tile the internal media
work added); items 1-10 below are the External Agent's. Item 12 is information, not a task.

## 1. Remove Enter-to-submit shortcuts

Create Project (`apps/web/src/app/page.tsx`, the name input's `onKeyDown`) and the Ask AI
composer (`apps/web/src/components/AskAi.tsx`, Enter submits, Shift+Enter newline) fire on
Enter, which users hit by accident while composing (especially multi-line/CJK input).
Remove Enter-to-submit in both; submission is by the button only. Check other composers and
inputs for the same pattern.

## 2. Workflow step numbers are off-center

The numbered circles in the top workflow stepper (Shell stepper, images in the feedback)
render the digit off-center in its circle. Fix the alignment (line-height / flex centering)
for current, done and upcoming states.

## 3. Ask AI composer must auto-grow

The chat textarea has a fixed height. Make it grow with content up to a maximum height,
then scroll internally; keep the scrollbar hidden. Applies to the Ask AI composer (and the
same composer pattern anywhere else).

## 4. Stream the agent's output

Agent replies arrive all at once (`llm.chat` in `apps/agents/src/runtime.ts`; the turn is
one request/response through the bff). Stream the reply text to the panel as it is produced.
The platform contract already carries streaming (`AgentModel.chatStream`,
`LabelingModels.chatStream`, gateway included); what is missing is the plumbing: a turn
needs a way to emit partial text (an events/callback channel on the bff turn call, rendered
incrementally by the panel). Keep tool calls, proposals and audit behavior as they are;
stream at least the final reply text, with the thinking state visible while the model works
(see item 7).

## 5. Show form-affecting tool calls in the chat

Today the chat shows message text only. When an agent uses a tool that changes what the user
sees or spends — proposals applied to a form (schema/prompt drafts landing in the page's
fields), and the paid start tools — show a compact line in the chat (agent, what it did,
when), so users can tell the form did not change by itself. Read-only lookups do not need a
line. Related facts the user asked about: history is one stream per project
(`chat_messages`), every page's panel loads all of it, and the entry agent changes per page;
replies render under a generic "AI" label although `msg.agent` is stored — show the preset
name. Tool calls are currently recorded only in telemetry and the catalog audit log
(`agent.tool` entries) and are visible nowhere in the UI.

### Assessment of the current design (internal agent, 2026-11-09)

The history model is right; its presentation is not.

- **One history per project, inherited across pages: keep.** The product concept is "the
  page is the agent's workspace": one project, one conversation, specialists handing off
  behind the front desk. Splitting history per page would fragment exactly the continuity
  that makes handoffs and follow-up questions work, and the page each message came from is
  already stored on the message. The agents themselves only ever see the last 8 messages
  (`recentHistory`), so the shared stream does not flood their context either.
- **Flattening every speaker to "AI" is wrong.** `msg.agent` is stored and then thrown away
  at render: users cannot tell a front-desk answer from a schema or evaluation specialist's,
  although the presets have different authority (only some may draft schemas or start paid
  work). Show the preset name on agent messages; keep the user's messages as they are.
- **Invisible tool calls are the real gap.** The system already records everything —
  telemetry counters, `agent_tool_called` events, and audit entries with agent, tool name
  and args in the catalog — but none of it reaches the one place the user is looking.
  Combined with silent form editing (a proposal lands in the page's fields with no trace in
  the conversation), users cannot answer "who changed this, and why". That is a trust and
  debuggability problem, not a cosmetic one: paid start tools spend money, and their only
  visible trace today is a reply the model happens to write.
- **Do not overcorrect.** Dumping every read-only lookup into the chat would bury the
  conversation; the audit log is the right home for those. The line to draw is the one
  above: anything that changes page state, saves data, or spends money gets a compact,
  timestamped line in the stream (including proposal approvals and discards, which are
  state changes by the user); pure reads stay in the audit log. Persist these lines as
  `role: 'event'` messages so they survive reloads and appear in the right order, rather
  than reconstructing them from the audit log at render time.
- **Two smaller inconsistencies worth fixing with it.** The 8-message window the agents
  see is invisible to users, who reasonably assume the agent remembers the whole visible
  conversation; a subtle "the agent sees recent messages" hint or a longer window closes
  that expectation gap. And because history is project-wide, long projects accumulate one
  endless stream — day separators (already natural with `createdAt`) keep it scannable
  without changing the model.

## 6. Schema approval must live on the main page, not only in the chat

After the schema agent drafts a schema, the only Approve is in the Ask AI panel
(`apps/web/src/app/setup/page.tsx` shows the draft fields but offers no save/approve of its
own). Put the approve/save action on the Setup page itself (the chat card may stay as a
shortcut). Users who close the panel currently have no way to accept the draft they are
looking at.

## 7. Add basic motion and pending/failure states

The UI is fully static, which reads as "frozen" during slow work. Add restrained motion:
spinners on running status labels (agent thinking, sampling, labeling, optimiser), animated
progress bars, panel/page content transitions, and a pending state on Approve buttons —
approving runs real async work (bff calls and storage writes; on the internal build these
are network requests), takes seconds, and currently gives no feedback; on failure (weak
network) nothing is shown at all. Every async button should disable while pending and
surface a retryable error. Audit all pages for missing pending/error states, not just these.

## 8. Make unavailable temperature obvious

On Setup's model step, a model without temperature support renders a disabled input
containing a dash (`apps/web/src/app/setup/page.tsx`). Make it clearly unavailable: grey
the option label and the field background (a proper disabled style), not just a dash in a
normal-looking box.

## 9. Step navigation must not white-flash

Clicking "Next: ..." reloads into a blank page before the next step appears. Navigate
without the white flash: keep the shell mounted and swap the main panel's content with a
transition (item 7), showing a loading state in the panel while the next page's state
loads, instead of a blank document.

## 10. Slow down the simulated sampling

Sampling finishes too fast to inspect the page (the prepared-file source paces progress at
120 ms per 8 examples in `packages/platform/src/standins/sample-examples.ts`). Slow the
simulated sampling progress down (roughly 3-4x slower, still finishing in seconds) so the
sampling state, progress and Stop can be checked by eye.

## 11. Gold Labels player tile (FIXED internally)

The tile was 16:9 with the item id over the player's bottom-left controls. Short-form items
are portrait: the tile is now a tall stage (`min(66vh, 640px)`, content contained), and the
item id is a centered top chip with `pointer-events: none`, so the player's own play/volume
controls stay usable. Fixed in `apps/web/src/ui/kit.css` by the internal agent, since the
media tile came with the internal media work.

## 12. Information: the first prompt draft is real model output

The drafted first prompt (acceptance screenshot 5) is generated live by the reasoning model
through the internal agent adapter, not canned text — it cites the schema values the schema
agent had just proposed (for example `mild_suggestive`), which only exist in that session.
On a stand-in build the scripted agent returns fixed drafts instead.
