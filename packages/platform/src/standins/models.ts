import type {LlmModelInfo} from '@yushiguang/sprint-contracts';

/**
 * The model registry of the stand-in agent model (deployment readiness spec, 5): what a hosting
 * platform's `AgentModel.models()` returns. Only public model names; the ids are opaque to the
 * rest of the platform, which never lists them as a type.
 */
export const STAND_IN_MODELS: LlmModelInfo[] = [
  {
    id: 'gpt-5.6-terra',
    name: 'gpt-5.6-terra',
    tier: 'reasoning',
    description: 'Highest-quality reasoning model for schema design, prompt drafting, and optimiser reflection.',
    capabilities: {vision: true, tools: true, reasoningEffort: ['low', 'medium', 'high'], contextTokens: 400_000, temperature: false},
    priceIn: 1.25,
    priceOut: 5.0,
    active: true,
  },
  {
    id: 'gpt-5.6-luna',
    name: 'gpt-5.6-luna',
    tier: 'balanced',
    description: 'Balanced quality and latency model for multi-turn agent tasks and evaluation analysis.',
    capabilities: {vision: true, tools: true, reasoningEffort: ['low', 'medium', 'high'], contextTokens: 400_000, temperature: false},
    priceIn: 1.0,
    priceOut: 4.0,
    active: true,
  },
  {
    id: 'gpt-5.4',
    name: 'gpt-5.4',
    tier: 'fast',
    description: 'Fast, lower-cost model suitable for front-desk routing and high-volume labeling.',
    capabilities: {vision: true, tools: true, reasoningEffort: ['minimal', 'low', 'medium'], contextTokens: 200_000, temperature: false},
    priceIn: 0.75,
    priceOut: 3.0,
    active: true,
  },
  {
    id: 'gpt-5.5',
    name: 'gpt-5.5',
    tier: 'balanced',
    description: 'Registered but not served (inactive): calls that name it fall back to another model.',
    capabilities: {vision: true, tools: true, reasoningEffort: ['low', 'medium', 'high'], contextTokens: 200_000, temperature: false},
    priceIn: 1.1,
    priceOut: 4.4,
    active: false,
  },
];
