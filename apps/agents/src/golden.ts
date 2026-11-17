import type {
  AgentModel,
  AgentRuntimeContract,
  AgentToolCall,
  AgentToolRequest,
  AgentTurnEvent,
  AgentTurnOutput,
  AgentTurnRequest,
  DraftImprovementOutput,
  DraftImprovementRequest,
  LlmStreamChunk,
  OptimiserReflectOutput,
  OptimiserReflectRequest,
} from '@sprint/contracts';

/**
 * Golden agent fixtures (deployment readiness spec, 4.6 and 6): fixed requests with the model's
 * replies and the tool results they meet, and the output the reference runtime gives. They are
 * plain JSON files in `apps/agents/fixtures/`, so an agent runtime in any language can be held to
 * the same cases; `fixtures.test.ts` replays them on this runtime. See `fixtures/README.md`.
 */

/** One tool call of a fixture: what the helper asks, and what the host answers (a result or an error). */
export interface GoldenToolCall extends AgentToolRequest {
  result?: unknown;
  error?: string;
}

/** A turn's output without timings: tool calls drop `ms`. */
export type GoldenTurnOutput = Omit<AgentTurnOutput, 'toolCalls'> & {toolCalls: Omit<AgentTurnOutput['toolCalls'][number], 'ms'>[]};

interface FixtureBase {
  name: string;
  /** The guards and behaviours the case holds an implementation to, in words. */
  guards: string[];
  /** The model's replies in the order the reference runtime asked for them. */
  model: string[];
  /** The tool calls the helpers make, in order, each with the host's answer. */
  tools: GoldenToolCall[];
}

/** A fixture's request, by kind. */
export type GoldenRequest = {kind: 'turn'; request: AgentTurnRequest} | {kind: 'reflect'; request: OptimiserReflectRequest} | {kind: 'improve'; request: DraftImprovementRequest};

export type GoldenFixture = FixtureBase &
  (
    | {kind: 'turn'; request: AgentTurnRequest; expected: GoldenTurnOutput}
    | {kind: 'reflect'; request: OptimiserReflectRequest; expected: OptimiserReflectOutput}
    | {kind: 'improve'; request: DraftImprovementRequest; expected: DraftImprovementOutput}
  );

export function goldenTurnOutput(out: AgentTurnOutput): GoldenTurnOutput {
  return {...out, toolCalls: out.toolCalls.map(({ms: _ms, ...c}) => c)};
}

/** The project, turn and context every tool call of this request must carry. */
export function callContext(fx: GoldenRequest): Pick<AgentToolCall, 'projectId' | 'turnId' | 'ctx'> {
  if (fx.kind === 'turn') return {projectId: fx.request.workspace.projectId, turnId: fx.request.turnId, ctx: fx.request.ctx};
  return {projectId: fx.request.projectId, turnId: null, ctx: fx.request.ctx};
}

/** Sends the fixture's request to a runtime; a turn's output loses its timings. */
export async function runRequest(rt: AgentRuntimeContract, fx: GoldenRequest): Promise<unknown> {
  if (fx.kind === 'turn') return goldenTurnOutput(await rt.runTurn(fx.request));
  if (fx.kind === 'reflect') return rt.reflectPrompt(fx.request);
  return rt.draftImprovement(fx.request);
}

/**
 * A model that gives the recorded replies in order, whether the runtime asks for a whole answer
 * or a stream (a stream gets the reply as one piece). `left()` says how many were not asked for.
 */
export function replayModel(replies: string[]): AgentModel & {left(): number} {
  let i = 0;
  const next = async () => {
    if (i >= replies.length) throw new Error(`The fixture has ${replies.length} model replies; the runtime asked for more.`);
    return replies[i++];
  };
  return {
    models: () => [],
    chat: next,
    complete: async () => ({text: await next(), model: 'fixture', stopReason: 'end_turn', usage: {inputTokens: 0, outputTokens: 0}}),
    async *chatStream(): AsyncGenerator<LlmStreamChunk> {
      yield {type: 'delta', text: await next()};
      yield {type: 'done', createdAt: '2026-01-01T00:00:00.000Z'};
    },
    left: () => replies.length - i,
  };
}

/** Events a turn published, as the progress port received them. */
export type PublishedEvent = {projectId: string; turnId: string; event: AgentTurnEvent};
