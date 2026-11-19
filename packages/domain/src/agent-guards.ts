import type {AgentPreset, AgentSkillName, AgentToolName} from '@yushiguang/sprint-contracts';

/**
 * Which helper may call which tool (deployment readiness spec, 6; review P4). The runtime tells a
 * helper about its own tools only, and the tool host refuses any other, so the list holds even when
 * the runtime is reimplemented elsewhere.
 */

/** Tools that spend money. They start at once; the user stops them from the page. */
export const START_TOOLS: AgentToolName[] = ['try_prompt', 'score_version', 'start_optimiser'];

/** Every helper can file a problem report (spec 1.1.0, 3). */
const REPORT: AgentToolName[] = ['report_problem'];

/** Reads every helper has (#39): where the project stands, what runs, what uploads did, the guide. */
const READ_BASICS: AgentToolName[] = ['get_gates', 'get_running_work', 'get_upload_result', 'read_guide'];

const READ_ALL: AgentToolName[] = ['get_page_view', 'get_project_summary', 'list_versions', 'get_version', 'compare_versions', 'get_report', 'get_dataset_stats', 'get_mismatch_summary', 'get_examples', 'search_examples', 'get_gold_labels', 'get_predictions', 'get_optimiser_run', ...READ_BASICS];

export const PRESET_TOOLS: Record<AgentPreset | 'optimiser', AgentToolName[]> = {
  // get_dataset_stats and search_examples: the plan_labeling skill on Gold Labels (#39).
  front_desk: ['get_page_view', 'list_versions', 'get_version', 'get_report', 'get_examples', 'get_dataset_stats', 'search_examples', 'read_doc', ...READ_BASICS, ...REPORT],
  prompt_agent: [...READ_ALL, 'get_drafts', 'get_mistakes', 'get_flips', 'get_confusions', 'check_prompt', 'read_feature_info', 'read_doc', ...START_TOOLS, ...REPORT],
  evaluation_agent: [...READ_ALL, 'get_flips', 'get_confusions', 'score_version', 'start_optimiser', ...REPORT],
  // The Optimiser's calls go out as the Prompt helper's (`read_feature_info` only).
  optimiser: ['read_feature_info'],
};

/** May this helper call this tool? */
export const mayCallTool = (agent: AgentPreset | 'optimiser', name: string): boolean => (PRESET_TOOLS[agent] as string[] | undefined)?.includes(name) ?? false;

/** Handoffs go only to these specialists; anything else is ignored (no handoff). */
export const HANDOFF_TARGETS: AgentPreset[] = ['prompt_agent', 'evaluation_agent'];

/** The skills each helper may run (#39, step 2). A skill's tools must be the helper's tools too. */
export const PRESET_SKILLS: Record<AgentPreset, AgentSkillName[]> = {
  front_desk: ['plan_labeling'],
  prompt_agent: ['improve_from_mistakes', 'review_label_set', 'diagnose_score_change'],
  evaluation_agent: ['diagnose_score_change'],
};
