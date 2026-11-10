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

---

# Round 2 (acceptance on sprint-dev v7, project "video")

Owner split as before: item 3 is fixed internally (the media strip is internal media work);
items 1, 2, 4, 5 are the External Agent's; item 6 is a joint diagnosis, no fix yet.

## R2-1. Setup must show the finished setup, not jump back into schema editing

After finishing Setup, returning to the step lands directly on the schema settings editor
instead of showing the completed choices (task, schema, thresholds, models) as a summary
with Edit actions. A finished step should read as done; editing is a deliberate action.

## R2-2. Model answer must start hidden for every example

On Gold Labels the model answer is shown by default, and once shown it stays shown when
moving to the next example (`showModel` is page-level state). For unbiased labeling the
answer starts hidden per example; revealing is per example, and the `revealed` flag recorded
with the gold label must match what the labeler actually saw on that example.

## R2-3. Still thumbnails under the player did nothing (FIXED internally)

The thumbnails are the item's still images (its Cover and Images features, via the media
source). Clicking one only changed state behind the player iframe, so nothing visibly
happened. Now: clicking a still switches the main tile to that image, a "Player" button
switches back, and a caption says what the strip is.

## R2-4. Features on Gold Labels are easy to miss

The example card does render feature rows (text features, plus any other non-image feature),
but with the pilot data that is only Title / Description / On-screen text under a tall media
tile, so the page reads as "no features". Make the feature block clearly headed (for example
a "Features" title with the item's text features), and keep image features represented by
the still strip rather than silently dropped from the list.

## R2-5. A running optimiser needs a card on the page, and animated event icons

When the workflow starts the optimiser automatically, the Prompt Versions page shows no
indication anything is running; the only trace is a static chat event line ("Workflow
started the optimiser on ...") whose icon does not animate. Add a running-optimiser card
on the page (model, candidates so far, calls, cost, Stop — the run data is already in
project state), and animate the icon on in-progress event lines in the chat.

## R3-1. Dashed-underline hints never show, and are overused

**Status 2026-11-10:** done in PR #4 (see `docs/ui-gaps.md`, "Done on 2026-11-10: acceptance round 3").

`Hov` (`apps/web/src/ui/index.tsx`) renders a dashed underline with `cursor: help` but
relies on the native `title` attribute, which in practice shows nothing for these spans
(and is unreachable by keyboard/touch). Replace it with the custom tooltip the editor
already uses for removed-text hovers (positioned popover), and trim the vocabulary: only
genuinely non-obvious terms get the treatment (Filtered, Failed, rounds, distribution
warnings), not everyday words.

## R3-2. Long user messages overflow the chat bubble

**Status 2026-11-10:** done in PR #4 (see `docs/ui-gaps.md`, "Done on 2026-11-10: acceptance round 3").

A long unbroken string (a pasted prompt as JSON, see the acceptance screenshot) spills
past the grey user bubble. User message text needs wrapping (`overflow-wrap: anywhere`
and `min-width: 0` on the bubble column) in Ask AI message rendering.

## R3-3. The agent cannot see the editor's unsaved feature selection

**Status 2026-11-10:** done in PR #4 (see `docs/ui-gaps.md`, "Done on 2026-11-10: acceptance round 3").

Partly implemented and currently broken: the prompt editor page sends the draft template
in its page context (`apps/web/src/app/(project)/prompt/edit/page.tsx`) but not
`draft.features`, so when a user asks "update the prompt based on currently selected
features", the agent truthfully answers that it cannot see them. Send the full draft —
template and feature selection (and images) — in the page context on both prompt pages,
and confirm the page view's `unsaved` block carries them to the agent.

## R3-4. Project list needs a loading state

**Status 2026-11-10:** done in PR #4 (see `docs/ui-gaps.md`, "Done on 2026-11-10: acceptance round 3").

The home page sits blank/empty while the project list loads. Show a loading indicator
(skeleton rows or a spinner with "Loading projects") until the first list arrives, and an
error state if it fails.

## R3-5. Buttons that fetch or navigate still freeze without feedback

**Status 2026-11-10:** done in PR #4 (see `docs/ui-gaps.md`, "Done on 2026-11-10: acceptance round 3").

Round 1 item 7 covered buttons that run work; the gap remains on buttons that fetch data
or jump pages: the click lands, nothing moves for a while, then the page changes. Users
cannot tell a slow request from a hang. Every such button needs the pending treatment
(spinner/disable, then navigate), and page loads need the panel loading state from item 9
of round 1 — audit navigation and fetch buttons across pages, not only submit actions.

## R3-6. "Improve with AI" must open the Ask AI panel

**Status 2026-11-10:** done in PR #4 (see `docs/ui-gaps.md`, "Done on 2026-11-10: acceptance round 3").

Clicking Improve with AI navigates to the prompt editor but leaves the panel closed and
nothing animates; a new user does not know the helper is working there or what to do next.
Any navigation that starts (or continues) agent work must open the Ask AI panel on arrival
(and show the working line), so the user lands where the action is.

## R3-7. Auto Optimise from a non-best version needs a confirmation

**Status 2026-11-10:** done in PR #4 (see `docs/ui-gaps.md`, "Done on 2026-11-10: acceptance round 3").

If the user starts Auto Optimise from a version that is not the highest-scoring minor of
its major line, ask first with a dialog: continue from the selected version, or switch the
base to the best-scoring minor of that major. Default the dialog's primary action to the
best-scoring minor. "Best" is by the current report scores on the project's model.

## R3-8. Prompt Versions layout jumps when cards change

**Status 2026-11-10:** done in PR #4 (see `docs/ui-gaps.md`, "Done on 2026-11-10: acceptance round 3").

The version list and detail cards change size as their content changes, shifting the whole
page (it reads as a screen jolt). Give the version list a stable height and animate detail
card changes (height/content transition). The exact treatment is the External Agent's
choice; the requirement is no layout shift of surrounding content while interacting.

## R3-9. Why optimisation gains look small and random (analysis, with asks)

**Status 2026-11-10:** done in PR #4 (see `docs/ui-gaps.md`, "Done on 2026-11-10: acceptance round 3").

Three compounding causes, in likely order:

1. **The optimiser reflects without seeing examples.** `OptimiserReflectInput` carries the
   template, features, schema, tried changes, the top mix-ups and the lowest field/value —
   aggregate confusion pairs only, never the actual mistaken examples (their text features,
   the gold answer, what the model answered). Changes are therefore generic ("clarify the
   boundary") rather than aimed at the specific items being missed. Ask: include a bounded
   set of the parent's wrong examples (say up to 8: external id, text features, gold,
   predicted) in the reflect input for 'change' mode, and say in the system prompt that
   changes must cite them.
2. **Small, noisy halves.** A 50-example eval gives a 10-example dry run and 25 held-out;
   one example is 10 points of dry-run score, so keep/drop decisions are close to coin
   flips, and the gold itself is model-produced (agreement has a ceiling well under 1.0).
   Nothing to code here beyond not pretending precision; the dry-run size could scale with
   the optimiser half (for example half of it, capped at 20).
3. **Ceiling of a decent base prompt.** When v1 already separates the easy classes, the
   remaining errors are boundary cases (weak vs strong) where single targeted changes
   trade one class against another; expect slow, non-monotonic progress and say so in the
   progress panel (rounds tried, best so far) instead of implying steady improvement.

## R3-10. Agents act too eagerly; converse and confirm first

**Status 2026-11-10:** done in PR #4 (see `docs/ui-gaps.md`, "Done on 2026-11-10: acceptance round 3").

Across pages the agents move straight to drafting, editing the form, or proposing starts
when intent is ambiguous. Adjust the preset system prompts and runtime guidance: when a
request is underspecified or several readings are plausible, ask one short clarifying
question first (and wait), summarise what they are about to change before a proposal that
rewrites a lot, and never treat a question ("what does X mean", "why did F1 drop") as an
instruction to change something. Existing approval gates stay; this is about not rushing
to them.

## R2-6. Optimiser on the real platform: very slow, one run died with "Failed to fetch"

Diagnosis from the deployed database (project "video", 2026-11-09): the workflow started
an optimiser run on Model A at 10:00 UTC; it failed at 10:04 with `Last error: Failed to
fetch` (candidates 0, cost already $5.04), and a Model B run started immediately after,
still `running` with 0 candidates long afterwards. No optimiser labeling task was ever
created, so the time goes before the first candidate: parent scoring and the reasoning
model's reflection call(s), at `maxOutputTokens` 9000 with image-heavy prompts. The browser
check exercises the optimiser only against the stand-in (scripted model, simulated calls),
so the real path — streamed agent calls and labeling through the live gateway — is untested
end to end. Needed: per-phase progress inside a run (which phase, since when), a bounded
timeout with a surfaced, retryable error for reflection/agent calls instead of an unbounded
wait, and a real-platform smoke of one optimiser run before the next acceptance round.
Whether "Failed to fetch" came from the page network or the platform transport needs the
internal agent's follow-up with the run's browser session; the loop must not silently start
a second paid run after such a failure without telling the user.
