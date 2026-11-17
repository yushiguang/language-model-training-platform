import type {AgentPreset, ClientDiagnostics, Locale, PageContext, TicketSubmission} from '@tsp/contracts';
import {agentName, msg, systemConfig, versionLabel} from '@tsp/domain';
import {getApp, now, tm} from './app.ts';
import {postEvent} from './chat-events.ts';
import {loadProjectState} from './projects.ts';

/**
 * Problem reports (spec 1.1.0, 3). Any helper can call `report_problem`: first without `send` to
 * draft the report, which it shows the user; then with `send: true` once the user agrees. Code
 * refuses a send unless a draft exists and the user has written since it was made, so a helper
 * can never send in the turn it drafted. The browser's rolling record (`ClientDiagnostics`) and
 * the language arrive with the user's message and are kept for that turn only.
 */

interface TurnContext {
  page: PageContext;
  locale: Locale;
  client: ClientDiagnostics | null;
}

const turns = new Map<string, TurnContext>();

/** What the running turn knows about the user's page, language and browser. */
export function beginTurn(projectId: string, ctx: TurnContext): void {
  turns.set(projectId, ctx);
}

export function endTurn(projectId: string): void {
  turns.delete(projectId);
}

interface Fields {
  summary: string;
  expected: string;
  actual: string;
  steps: string[];
}

interface Draft extends Fields {
  createdAt: string;
  includeContent: boolean;
}

const drafts = new Map<string, Draft>();

const str = (x: unknown, max: number) => (typeof x === 'string' ? x.trim().slice(0, max) : '');

function readFields(args: Record<string, unknown>, base?: Fields): Fields {
  const steps = Array.isArray(args.steps) ? args.steps.map(s => str(s, 200)).filter(Boolean).slice(0, 10) : null;
  return {
    summary: str(args.summary, 200) || base?.summary || '',
    expected: str(args.expected, 1000) || base?.expected || '',
    actual: str(args.actual, 1000) || base?.actual || '',
    steps: steps ?? base?.steps ?? [],
  };
}

/** The `report_problem` tool. Returns a draft to show the user, the ticket id, or an error to act on. */
export async function reportProblem(projectId: string, agent: AgentPreset, args: Record<string, unknown>): Promise<unknown> {
  const {tickets, catalog} = getApp();
  if (!tickets) return {error: 'Problem reports cannot be sent from this site. Tell the user to report it to their team directly.'};
  const turn = turns.get(projectId) ?? null;
  const page = turn?.page.where?.page ?? 'other';
  const client = turn?.client ?? null;

  if (args.send !== true) {
    const fields = readFields(args);
    if (!fields.summary && !fields.actual) return {error: 'Give at least a one-line summary of what went wrong.'};
    const includeContent = args.includeContent === true;
    drafts.set(projectId, {...fields, includeContent, createdAt: now()});
    tm().event('problem_report_drafted', {page});
    return {
      draft: fields,
      attached: [
        'the page and the project it is about',
        'your recent actions in Ask AI',
        `${client?.failedCalls.length ?? 0} failed backend calls and ${client?.errors.length ?? 0} script errors from this browser`,
        'your browser, screen size and time zone',
        ...(includeContent ? ['the prompt of the version in question'] : []),
      ],
      notAttached: includeContent ? ['examples and gold labels'] : ['your prompt, examples and gold labels'],
      next: 'Show the user this draft in a few short lines and ask whether to send it. Call report_problem again with "send": true only after the user says yes.',
    };
  }

  const draft = drafts.get(projectId);
  if (!draft) return {error: 'There is no draft to send. Draft the report first (without "send") and ask the user.'};
  const [lastUser] = await catalog.find('chat_messages', {projectId, role: 'user'}, 'createdAt desc');
  if (!lastUser || lastUser.createdAt <= draft.createdAt) return {error: 'The user has not answered yet. Ask whether to send the report, and wait for the answer.'};

  const state = await loadProjectState(projectId);
  const includeContent = typeof args.includeContent === 'boolean' ? args.includeContent : draft.includeContent;
  const fields = readFields(args, draft);
  const params = {...(turn?.page.where?.params ?? {})};
  const version = state ? (state.versions.find(v => v.id === params.v) ?? state.versions[0]) : undefined;
  const events = (await catalog.find('chat_messages', {projectId, role: 'event'}, 'createdAt desc')).slice(0, systemConfig().reports.actionLines).reverse();
  const user = await getApp().user();
  const ticket: TicketSubmission = {
    ...fields,
    reporter: {id: user.id, name: user.name},
    locale: turn?.locale ?? 'en',
    filedBy: agentName(agent),
    createdAt: now(),
    where: {
      appVersion: getApp().appVersion ?? 'unknown',
      projectId,
      projectName: state?.project.name ?? null,
      page,
      params,
      approvedSteps: state?.project.approvedNodes ?? [],
      settings: state?.setup ? {passRule: state.setup.thresholds?.mode ?? 'none', model: state.endpoints.find(e => e.id === state.setup!.models[0]?.endpoint)?.name ?? state.setup.models[0]?.endpoint ?? ''} : null,
    },
    actions: events.map(e => ({at: e.createdAt, text: e.text})),
    diagnostics: client,
    content: includeContent && version ? {versionLabel: versionLabel(version), prompt: version.template} : null,
  };
  const {ticketId} = await tickets.submit(ticket);
  drafts.delete(projectId);
  await catalog.audit(projectId, user.name, 'problem.report', {ticketId});
  await postEvent(projectId, 'report', 'user', msg('sent a problem report {ticket}', {ticket: ticketId}));
  tm().event('problem_reported', {page, has_content: !!ticket.content, failed_calls: client?.failedCalls.length ?? 0, errors: client?.errors.length ?? 0});
  return {ticketId, note: 'Tell the user the ticket id in one line; the team picks the report up from there.'};
}
