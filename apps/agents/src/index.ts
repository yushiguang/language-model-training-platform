import type {AgentRuntimeContract, AgentRuntimeDeps} from '@tsp/contracts';
import {draftImprovement, reflectPrompt, runAgentTurn} from './runtime.ts';

export * from './presets.ts';
export * from './runtime.ts';

/**
 * The agent runtime behind the contract the bff uses (spec 1.0.0, 7.1.3): the model, the tools and
 * the progress port come in once here, so each call is plain data and could cross a network.
 */
export function createAgentRuntime(deps: AgentRuntimeDeps): AgentRuntimeContract {
  const running = new Map<string, AbortController>();
  return {
    runTurn: ({turnId, ...input}) => runAgentTurn(input, deps.llm, deps.tools(input.workspace.projectId), deps.progress ? p => deps.progress!.publish(input.workspace.projectId, turnId, p) : undefined),
    async reflectPrompt({projectId, requestId, ...input}) {
      const ctrl = new AbortController();
      if (requestId) running.set(requestId, ctrl);
      try {
        return await reflectPrompt({...input, signal: ctrl.signal}, deps.llm, deps.tools(projectId));
      } finally {
        if (requestId) running.delete(requestId);
      }
    },
    draftImprovement: ({projectId, ...input}) => draftImprovement(input, deps.llm, deps.tools(projectId)),
    async cancel(requestId) {
      running.get(requestId)?.abort();
      running.delete(requestId);
    },
  };
}
