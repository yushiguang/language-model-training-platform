import type {AgentPreset, ChatLink, EndpointId, Msg, ProjectState} from '@tsp/contracts';
import {autoSpendUsd, canScore, compilePrompt, readStructured, evalEstimate, optimiserEstimate, versionLabel, visibleToAgents, systemConfig, msg} from '@tsp/domain';
import {getApp, tm} from './app.ts';
import {postEvent} from './chat-events.ts';
import {asModel, findVersion, modelName} from './page-views.ts';
import {loadProjectState} from './projects.ts';
import {scoreVersion, startOptimiser} from './work.ts';

/**
 * Start-work agent tools: try_prompt, score_version, start_optimiser. They spend money and
 * start at once, like every automatic start: the cost can't be predicted exactly, and every
 * running task has a Stop button.
 */

type StartTool = 'try_prompt' | 'score_version' | 'start_optimiser';
export const START_TOOLS: StartTool[] = ['try_prompt', 'score_version', 'start_optimiser'];
export const isStartTool = (name: string): name is StartTool => (START_TOOLS as string[]).includes(name);

interface Planned {
  /** The action line once it starts: "<helper> <line>", e.g. "started scoring v4 on gpt-5.4". */
  line: string | Msg;
  link?: ChatLink;
  estimateUsd: number;
  run: () => Promise<unknown>;
}

/** Checks the arguments and works out the label and cost of a start, without starting it. */
function plan(state: ProjectState, tool: StartTool, args: Record<string, unknown>): Planned {
  const projectId = state.project.id;
  const models = state.setup?.models ?? [];
  const pickModel = (): EndpointId => {
    const m = asModel(args.model, state) ?? models[0]?.endpoint;
    if (!m || !models.some(x => x.endpoint === m)) throw new Error(`${String(args.model)} is not the project's labeling model. It is ${models.map(x => modelName(state, x.endpoint)).join(', ')}.`);
    return m;
  };
  // The same guardrails as the page buttons and the auto-start manager (review 2026-11-13).
  if (!state.facts.settingsConfirmed) throw new Error('Project Settings are not confirmed yet. Ask the user to open Settings at the top of the page and confirm them first; nothing paid starts before that.');
  if (tool !== 'try_prompt' && !canScore(state.facts)) {
    const need = systemConfig().dataset.minEvalHard;
    throw new Error(`Scoring needs at least ${need} gold-labeled eval examples, 2 in each half (${state.facts.goldEvalDone} labeled so far). Ask the user to finish labeling on Gold Labels first.`);
  }
  switch (tool) {
    case 'try_prompt': {
      if (!state.setup?.schema) throw new Error('The labels are not set up yet.');
      const endpoint = pickModel();
      const base = state.versions[0];
      // No prompt given: try the newest version's ("try the current prompt").
      const structured = readStructured(args.prompt, base?.structured) ?? base?.structured;
      if (!structured) throw new Error('Give the prompt to try.');
      const draft = {template: compilePrompt(structured), features: structured.features, images: structured.images};
      const n = Math.max(1, Math.min(systemConfig().agent.tryTemplateMaxExamples, typeof args.n === 'number' ? Math.floor(args.n) : 3));
      const examples = state.examples.filter(e => e.split === 'eval' && visibleToAgents(e)).slice(0, n);
      if (!examples.length) throw new Error('There are no eval examples to try it on.');
      return {
        line: examples.length === 1 ? msg('tried the prompt on 1 eval example with {model}', {model: modelName(state, endpoint)}) : msg('tried the prompt on {n} eval examples with {model}', {n: examples.length, model: modelName(state, endpoint)}),
        estimateUsd: evalEstimate(state, draft, endpoint, examples.length),
        run: async () => {
          const settings = models.find(m => m.endpoint === endpoint)!;
          const rows = await getApp().labeling.tryTemplate({...draft, schema: state.setup!.schema!, settings, examples});
          const byId = new Map(examples.map(e => [e.id, e]));
          const costUsd = rows.reduce((a, r) => a + r.costUsd, 0);
          // No task is saved, so the try's spend is recorded here as automatic spend.
          if (costUsd > 0) await getApp().catalog.audit(projectId, 'system', 'auto_spend', {what: 'try_prompt', costUsd});
          return {
            model: modelName(state, endpoint),
            rows: rows.map(r => ({id: byId.get(r.exampleId)?.externalId, title: byId.get(r.exampleId)?.title, model: r.answer, invalid: r.invalidReason, error: r.error, gold: state.gold[r.exampleId]?.answer ?? null})),
            saved: false,
          };
        },
      };
    }
    case 'score_version': {
      const v = findVersion(state, args.version);
      if (!v) throw new Error(`There is no version "${String(args.version)}". Versions: ${state.versions.map(versionLabel).join(', ')}.`);
      const endpoint = pickModel();
      if (state.runs.some(r => r.promptVersionId === v.id && r.endpoint === endpoint && (r.state === 'done' || r.state === 'running'))) {
        return {line: '', estimateUsd: 0, run: async () => ({already: `${versionLabel(v)} is already scored or being scored on ${modelName(state, endpoint)}.`})};
      }
      return {
        line: msg('started scoring {version} on {model}', {version: versionLabel(v), model: modelName(state, endpoint)}),
        link: {path: '/prompt'},
        estimateUsd: evalEstimate(state, v, endpoint),
        run: async () => {
          void scoreVersion(projectId, v, endpoint, {auto: true});
          return {started: true, note: 'Scoring runs on the eval set; the report appears when it finishes.'};
        },
      };
    }
    case 'start_optimiser': {
      const endpoint = pickModel();
      if (state.optimisation.some(o => o.state === 'running')) return {line: '', estimateUsd: 0, run: async () => ({already: 'The Optimiser is already running.'})};
      const rounds = typeof args.rounds === 'number' ? Math.max(1, Math.min(systemConfig().optimiser.maxRoundsCap, Math.round(args.rounds))) : systemConfig().optimiser.defaultMaxRounds;
      return {
        line: msg('started the Optimiser for up to {rounds} rounds', {rounds}),
        link: {path: '/prompt'},
        estimateUsd: optimiserEstimate(state, endpoint, rounds),
        run: async () => {
          void startOptimiser(projectId, rounds, undefined, {auto: true});
          return {started: true, note: `The Optimiser tries up to ${rounds} changes; each one appears on Prompt versions, with its dry run or scores.`};
        },
      };
    }
  }
}

/**
 * Called by the agent tool host: runs the start at once, with no cost limit (the user stops it
 * from the page), and records it.
 */
export async function agentStart(projectId: string, agent: AgentPreset, tool: StartTool, args: Record<string, unknown>): Promise<unknown> {
  const state = await loadProjectState(projectId);
  if (!state) throw new Error('The project was not found.');
  const p = plan(state, tool, args);
  const spent = autoSpendUsd(state);
  const result = await p.run();
  if (p.line) await postEvent(projectId, 'start', agent, p.line, p.link);
  if (p.estimateUsd > 0) {
    await getApp().catalog.audit(projectId, `agent:${agent}`, 'auto_start', {what: tool, args, estimateUsd: p.estimateUsd, autoSpendUsd: spent});
    tm().counter('tsp_auto_starts_total', {what: tool, decision: 'started'});
    tm().event('auto_started', {what: tool, estimate_usd: p.estimateUsd, project_auto_spend_usd: spent});
  }
  return result;
}
