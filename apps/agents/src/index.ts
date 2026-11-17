import type {AgentRuntimeContract, AgentRuntimeDeps, RequestContext} from '@sprint/contracts';
import {draftImprovement, reflectPrompt, runAgentTurn, type ToolCaller} from './runtime.ts';

export * from './presets.ts';
export * from './runtime.ts';

/**
 * The agent runtime behind the contract the workflow uses (spec 1.0.0, 7.1.3; deployment readiness
 * spec, 6): the model, the tool host and the progress port come in once here, so each call is
 * plain data and could cross a network. Every tool call carries the project, turn and context of
 * the request it serves; the runtime keeps nothing between requests.
 */
export function createAgentRuntime(deps: AgentRuntimeDeps): AgentRuntimeContract {
  const running = new Map<string, AbortController>();
  const bind = (projectId: string, turnId: string | null, ctx: RequestContext): ToolCaller => ({call: req => deps.tools.call({...req, projectId, turnId, ctx})});
  return {
    async runTurn({turnId, ctx, ...input}) {
      const projectId = input.workspace.projectId;
      // A turn's events go out one at a time and in order; the answer waits for the last one.
      let sent: Promise<void> = Promise.resolve();
      const progress = deps.progress;
      const publish = progress
        ? (p: Parameters<typeof progress.publish>[2]) => {
            sent = sent.then(() => progress.publish(projectId, turnId, p)).catch(() => undefined);
          }
        : undefined;
      try {
        return await runAgentTurn(input, deps.llm, bind(projectId, turnId, ctx), publish);
      } finally {
        await sent;
      }
    },
    async reflectPrompt({projectId, requestId, ctx, ...input}) {
      const ctrl = new AbortController();
      if (requestId) running.set(requestId, ctrl);
      try {
        return await reflectPrompt(input, deps.llm, bind(projectId, null, ctx), ctrl.signal);
      } finally {
        if (requestId) running.delete(requestId);
      }
    },
    draftImprovement: ({projectId, ctx, ...input}) => draftImprovement(input, deps.llm, bind(projectId, null, ctx)),
    async cancel(requestId) {
      running.get(requestId)?.abort();
      running.delete(requestId);
    },
  };
}
