# AI-native design principles

These principles guide every design for Sprint. Check a new design or feature against them
before proposing it. They were written on 2026-10-30 and still stand; the notes at the end say
where the built product applies one differently.

## Where they come from

They were collected while building the frontend demo and reviewing it with the engineering team in October 2026. The demo treated users and the agent as colleagues and gave users many options. Users without engineering knowledge got confused and made mistakes. The fix was not a weaker agent or a smaller product, but a different split of roles between people, agents and code.

## Design principles

1. **Redesign the work, not the tool.** AI-native means redesigning the whole business workflow made of people and agents, then reassigning roles and responsibilities between them. It is neither handing agents to people as tools nor having an agent replace one human role one for one.
2. **Code owns the workflow; the LLM owns judgment inside a step.** Where the process is known and stable, its order, gates, thresholds and versioning live in code. The LLM gets only the judgments code can't make, such as drafting a schema, diagnosing errors or rewriting a prompt.
3. **Size the agent's freedom to what it knows.** A new agent lacks knowledge of our workflow, not intelligence, so we use a strong model with a narrow role: one job, few tools, a clear boundary. Its freedom grows only as measured results show it is earned.
4. **The agent leads; people are the source of business knowledge.** The agent asks for what it needs through one data-source interface. Whether a database, a file or a person answers is not the agent's concern. This makes agents testable with simulated answers, and lets data replace a human answer later without changing the agent. Human sources are slow and sometimes inconsistent, so agent tasks pause and resume, and answers are checked like any input. Scope: this holds when users lack professional knowledge. In products for professional users, people act as the agent's partner or even its manager.
5. **Code asks for accountable decisions, not the agent.** Business knowledge is something the agent can ask for. Approving cost, passing a gate or adopting a change are decisions someone is accountable for, so code requests them. An agent can never change its own grading: gold labels, indicators and thresholds are out of its reach.
6. **Confidence in evaluation comes before convenience.** A score is comparable only within one evaluation context: the same task definition, test examples with their correct answers, indicators and output-affecting settings. When anything that can move a score changes, older reports are archived. Changes that cannot move a score archive nothing.
7. **Everything is versioned, and stale states are blocked.** Every write names the versions it was based on, and the server rejects writes against a version that has been replaced.
8. **Spend people only where it matters.** There is one way to do each thing. Features that are complicated and not needed for the goal wait. Scope: this is for MVPs, agile development and quick showcases of a new product, not for every product or version.

## Human-computer interaction principles

1. **Assume no training.** Design for a first-time user who knows neither the platform nor ML. Every page answers three questions: what do I do now, what does done look like, and how far along am I.
2. **One thing at a time.** Each page has one main action and shows only the options and information that action needs. Everything else stays hidden.
3. **Typed questions by default; free chat only where language is the work.** Most input is a choice, a form or a label. Free chat is for inputs that are naturally language, like discussing a task and its policies, or how to improve a prompt.
4. **Progress is visible and never automatic.** Every step shows its threshold, its current status and a Next step button that stays grey until the threshold is met. A short animation signals when it turns on. The workflow never moves by itself, and pressing the button is the logged approval.
5. **Capture the question where it comes up.** A chat panel on every page already knows the page's context, so users never retype ids or explain where they are.
6. **Use the clearest existing output format.** When a clearly formatted way to show an output already exists, always use it; never invent a new one or fall back to a vaguer one. Agents talk in the chat, but their results appear on the page that owns them, for example a schema change as a diff in the schema editor with an Approve button, not as text in a chat message. The user moves there with a click and can jump back to the exact spot they left.
7. **Re-check on return.** When a page opens or regains focus, it checks the versions it was built on. An editable page built on a replaced version becomes read-only, with one button forward. A read-only page stays viewable with an Archived tag.
8. **Don't anchor the human.** When a person is the source of truth, as with labeling correct answers, the machine's answer is hidden by default. Revealing it takes a deliberate action, which is logged.

## How the built product applies them (2026-11-12)

- **Interaction principle 4, "never automatic".** The workflow still never moves to the next step
  by itself, but paid work inside a step does start by itself (scoring a saved version, resuming a
  paused run), with a Stop button on every task. Decided 2026-11-06: cost cannot be predicted and
  the goal is speed. The Optimiser is the exception and starts only when the user asks.
- **Design principle 7, "stale states are blocked".** Scores follow this through the evaluation
  context: a change that can move a score archives older reports. Rejecting a write that names a
  replaced version is not built yet.
- **Interaction principle 8, "don't anchor the human".** The model's answer is hidden while
  labeling and shown on the Mismatches tab, where comparing with it is the point.
- **Design principle 5, "an agent can never change its own grading".** Extended on 2026-11-11: no
  helper reads the held-out half of the eval set, and no helper judges a gold label.
