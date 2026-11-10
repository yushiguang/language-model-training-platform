import type {AgentRuntimeContract} from '@tsp/contracts';
import {reflectPrompt, runAgentTurn} from './runtime.ts';

export * from './presets.ts';
export * from './runtime.ts';

/** The agent runtime behind the contract the bff uses. */
export const agentRuntime: AgentRuntimeContract = {runAgentTurn, reflectPrompt};
