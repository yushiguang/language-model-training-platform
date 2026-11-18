import type {AgentPreset, AgentToolName} from '@yushiguang/sprint-contracts';

/**
 * Which helper may call which tool (deployment readiness spec, 6; review P4). The runtime tells a
 * helper about its own tools only, and the tool host refuses any other, so the list holds even when
 * the runtime is reimplemented elsewhere.
 */

/** Tools that spend money. They start at once; the user stops them from the page. */
export const START_TOOLS: AgentToolName[] = ['try_prompt', 'score_version', 'start_optimiser'];

/** Every helper can file a problem report (spec 1.1.0, 3). */
const REPORT: AgentToolName[] = ['report_problem'];

const READ_ALL: AgentToolName[] = ['get_page_view', 'get_project_summary', 'list_versions', 'get_version', 'compare_versions', 'get_report', 'get_dataset_stats', 'get_mismatch_summary', 'get_examples', 'search_examples', 'get_gold_labels', 'get_predictions'];

export const PRESET_TOOLS: Record<AgentPreset | 'optimiser', AgentToolName[]> = {
  front_desk: ['get_page_view', 'list_versions', 'get_version', 'get_report', 'get_examples', 'read_doc', ...REPORT],
  prompt_agent: [...READ_ALL, 'check_prompt', 'read_feature_info', 'read_doc', ...START_TOOLS, ...REPORT],
  evaluation_agent: [...READ_ALL, 'score_version', 'start_optimiser', ...REPORT],
  // The Optimiser's calls go out as the Prompt helper's (`read_feature_info` only).
  optimiser: ['read_feature_info'],
};

/** May this helper call this tool? */
export const mayCallTool = (agent: AgentPreset | 'optimiser', name: string): boolean => (PRESET_TOOLS[agent] as string[] | undefined)?.includes(name) ?? false;

/** Handoffs go only to these specialists; anything else is ignored (no handoff). */
export const HANDOFF_TARGETS: AgentPreset[] = ['prompt_agent', 'evaluation_agent'];
