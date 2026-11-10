import type {AgentPreset, ChatLink, EndpointId, ProjectState} from '@tsp/contracts';
import {autoSpendUsd, DEFAULT_MAX_ROUNDS, evalEstimate, optimiserEstimate, TRY_TEMPLATE_MAX, versionLabel} from '@tsp/domain';
import {getApp, tm} from './app.ts';
import {postEvent} from './chat-events.ts';
import {asModel, findVersion, modelName} from './page-views.ts';
import {loadProjectState} from './projects.ts';
import {scoreVersion, startOptimiser} from './work.ts';

/**
 * Start-work agent tools: try_template, score_version, start_optimiser. They spend money and
 * start at once, like every automatic start: the cost can't be predicted exactly, and every
 * running task has a Stop button.
 */

type StartTool = 'try_template' | 'score_version' | 'start_optimiser';
export const START_TOOLS: StartTool[] = ['try_template', 'score_version', 'start_optimiser'];
export const isStartTool = (name: string): name is StartTool => (START_TOOLS as string[]).includes(name);

interface Planned {
  /** The action line once it starts: "<helper> <line>", e.g. "started scoring v4 on gpt-5.4". */
  line: string;
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
    if (!m || !models.some(x => x.endpoint === m)) throw new Error(`${String(args.model)} is not one of the models chosen in Setup. Chosen: ${models.map(x => modelName(state, x.endpoint)).join(', ')}.`);
    return m;
  };
  switch (tool) {
    case 'try_template': {
      if (!state.setup?.schema) throw new Error('The labels are not set up yet.');
      const endpoint = pickModel();
      const base = state.versions[0];
      // No template given: try the newest version's ("try the current prompt").
      const template = typeof args.template === 'string' && args.template.trim() ? args.template : (base?.template ?? '');
      if (!template.trim()) throw new Error('Give the template to try.');
      const draft = {template, features: (args.features as typeof base.features | undefined) ?? base?.features ?? {video: [], photo_text: [], metadata: []}, images: base?.images ?? []};
      const n = Math.max(1, Math.min(TRY_TEMPLATE_MAX, typeof args.n === 'number' ? Math.floor(args.n) : 3));
      const examples = state.examples.filter(e => e.split === 'eval').slice(0, n);
      if (!examples.length) throw new Error('There are no eval examples to try it on.');
      return {
        line: `tried the prompt on ${examples.length} eval example${examples.length === 1 ? '' : 's'} with ${modelName(state, endpoint)}`,
        estimateUsd: evalEstimate(state, draft, endpoint, examples.length),
        run: async () => {
          const settings = models.find(m => m.endpoint === endpoint)!;
          const rows = await getApp().labeling.tryTemplate({...draft, schema: state.setup!.schema!, settings, examples});
          const byId = new Map(examples.map(e => [e.id, e]));
          const costUsd = rows.reduce((a, r) => a + r.costUsd, 0);
          // No task is saved, so the try's spend is recorded here as automatic spend.
          if (costUsd > 0) await getApp().catalog.audit(projectId, 'system', 'auto_spend', {what: 'try_template', costUsd});
          return {
            model: modelName(state, endpoint),
            rows: rows.map(r => ({id: byId.get(r.exampleId)?.externalId, title: byId.get(r.exampleId)?.title, model: r.answer, invalid: r.invalidReason, error: r.error, gold: state.gold.get(r.exampleId)?.answer ?? null})),
            costUsd,
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
        line: `started scoring ${versionLabel(v)} on ${modelName(state, endpoint)}`,
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
      const rounds = typeof args.rounds === 'number' ? Math.max(1, Math.min(50, Math.round(args.rounds))) : DEFAULT_MAX_ROUNDS;
      return {
        line: `started the Optimiser for up to ${rounds} rounds`,
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
