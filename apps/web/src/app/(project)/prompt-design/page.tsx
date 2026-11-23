'use client';

import {useSearchParams} from 'next/navigation';
import {Suspense, useEffect, useMemo, useState} from 'react';
import type {AgentProposal, PageContext, PromptVersion, StructuredPrompt} from '@yushiguang/sprint-contracts';
import {checkStructured, compilePrompt, emptyStructuredPrompt, shownVersions, structuredChangeSummary, structuredEquals, versionLabel, type ShownVersion} from '@yushiguang/sprint-domain';
import {useGo} from '@/components/nav';
import {Frame, ProjectPage} from '@/components/Shell';
import {useProject} from '@/components/ProjectContext';
import {FormDialog} from '@/components/shell/dialogs';
import {ChangesView, SectionsView} from '@/components/prompt/PromptSections';
import {PartDialog, type PromptPart} from '@/components/prompt/PromptDialogs';
import {closeDraft, useAgentDrafts, useOpenDraft} from '@/components/prompt/useAgentDrafts';
import {approveNode, createVersion, goldLabelsCleared, scoreVersion, stopRun, track, type ProjectState} from '@/backend-api';
import {Button, Card, CodeBlock, DropdownMenu, EmptyState, Heading, HStack, Icon, IconButton, SegmentedControl, SegmentedControlItem, StackItem, Text, Toolbar, VStack} from '@/ui/astryx';
import {CheckIcon, ClipboardDocumentIcon, DocumentTextIcon} from '@heroicons/react/24/outline';
import {action, num, PageTitle, useCopy} from '@/ui';
import {t, tm} from '@/i18n';

const FIRST = 'Tell me what to label. Any of these is a good start:';
const STARTERS = ['Paste a link to your labeling guide', 'Describe the task in a few sentences', 'Start from a prompt you already have'];

/**
 * Step 1, Prompt Design (wireframes v346, W-PromptDesign*): the prompt card on the left, Ask AI on
 * the right (always open here). The card shows one version (`?v=`, else the newest) in three views:
 * Sections (the parts, each edited in its own dialog), Changes (word marks against the version it
 * was made from) and Full prompt (the text the model reads). Save keeps the page's prompt: the first
 * save is v1; a later save overwrites the version on screen (a new save in its major, so the number
 * stays; every save is kept) and labels the dataset again.
 */
export default function PromptDesignPage() {
  return (
    <Suspense fallback={null}>
      <PromptDesignRouter />
    </Suspense>
  );
}

function PromptDesignRouter() {
  const vId = useSearchParams().get('v');
  const [page, setPage] = useState<PageContext>({label: 'Prompt Design', agent: 'prompt_agent', intent: 'draft_prompt', hint: FIRST, context: {}});
  return (
    <ProjectPage node="prompt_design" page={page} chatOpen>
      {({state}) => <Design state={state} vId={vId} setPage={setPage} />}
    </ProjectPage>
  );
}

function Design({state, vId, setPage}: {state: ProjectState; vId: string | null; setPage: (p: PageContext) => void}) {
  const shown = useMemo(() => shownVersions(state.versions, state.optimisation).filter(s => s.version), [state.versions, state.optimisation]);
  const asked = vId ? state.versions.find(v => v.id === vId) : undefined;
  const card = (asked && shown.find(s => s.major === asked.major)) ?? shown[0] ?? null;
  // A new save of the version on screen replaces it, and the page starts from the save.
  return <Editor key={card?.version?.id ?? 'new'} state={state} card={card} shown={shown} setPage={setPage} />;
}

type Confirm = {kind: 'stop'; percent: number} | {kind: 'clear'; n: number; removed: string[]} | null;

function Editor({state, card, shown, setPage}: {state: ProjectState; card: ShownVersion | null; shown: ShownVersion[]; setPage: (p: PageContext) => void}) {
  const go = useGo();
  const {href} = useProject();
  const projectId = state.project.id;
  const current = card?.version ?? null;
  const base = useMemo(() => current?.structured ?? emptyStructuredPrompt(), [current]);
  const [draft, setDraft] = useState<StructuredPrompt>(base);
  const [view, setView] = useState<'sections' | 'changes' | 'full'>('sections');
  const [part, setPart] = useState<PromptPart | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  // The Prompt helper's draft on the page: Save closes it as approved, Discard as discarded.
  const [proposal, setProposal] = useState<AgentProposal | null>(null);
  const take = (d: AgentProposal) => {
    setProposal(d);
    setDraft(d.payload.structured);
    // A helper's change to a saved version opens on its marks, each with the helper's reason.
    if (current) setView('changes');
  };
  useAgentDrafts(state, current?.id ?? '', !!current, take);
  const open = useOpenDraft(state);
  useEffect(() => {
    if (!current && open && open.id !== proposal?.id) take(open);
  }, [open?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = !structuredEquals(draft, base);
  const issues = useMemo(() => checkStructured(draft), [draft]);
  const started = !structuredEquals(draft, emptyStructuredPrompt());
  const parent = current?.parentId ? state.versions.find(v => v.id === current.parentId) : undefined;
  // Changes compare with what this prompt was made from: the saved version while editing, else its parent.
  const against: {prompt: StructuredPrompt; name: string} | null = dirty && current ? {prompt: base, name: t('the saved {version}', {version: card!.label})} : parent ? {prompt: parent.structured, name: nameOf(parent, shown)} : null;
  const running = current ? state.runs.filter(r => r.promptVersionId === current.id && r.purpose !== 'optimiser' && (r.state === 'running' || !!r.queue)) : [];

  useEffect(() => {
    setPage({
      label: current ? `Prompt ${card!.label}` : 'Prompt Design',
      agent: 'prompt_agent',
      intent: current || draft.label.values.length ? 'revise_prompt' : 'draft_prompt',
      hint: current ? 'Ask me about this prompt, or tell me what to change.' : FIRST,
      context: {prompt: draft, unsaved: dirty, ...(current ? {version: {label: card!.label, change: current.change}} : {})},
    });
  }, [current?.id, JSON.stringify(draft), dirty]); // eslint-disable-line react-hooks/exhaustive-deps

  const status = proposal && (dirty || !current) ? t('AI draft · not saved') : !current ? t('Not saved') : dirty ? t('Edited · not saved') : running.length ? t('Saved · labeling the dataset') : t('Saved');

  // Save: stop the version's run first (asked), then say which gold labels it clears (asked), then keep it.
  const save = async () => {
    if (running.length) {
      const done = running.reduce((n, r) => n + r.done, 0);
      const total = running.reduce((n, r) => n + r.total, 0);
      return setConfirm({kind: 'stop', percent: total ? Math.floor((done / total) * 100) : 0});
    }
    await checkCleared();
  };
  const checkCleared = async () => {
    const n = current ? await goldLabelsCleared({projectId, structured: draft}) : 0;
    if (n > 0) {
      const names = new Set(draft.label.values.map(v => v.name));
      return setConfirm({kind: 'clear', n, removed: base.label.values.map(v => v.name).filter(x => !names.has(x))});
    }
    await commit();
  };
  const commit = async () => {
    setConfirm(null);
    for (const r of running) await stopRun({projectId, runId: r.id});
    const v = await createVersion({
      projectId,
      structured: draft,
      parentId: current?.id ?? null,
      madeBy: proposal ? 'prompt_agent' : 'user',
      change: proposal?.payload.change || (current ? structuredChangeSummary(base, draft) : 'First prompt'),
      kind: current ? 'minor' : 'major',
    });
    await closeDraft(projectId, proposal?.id ?? null, 'approved').catch(() => undefined);
    if (!state.project.approvedNodes.includes('prompt_design')) await approveNode(projectId, 'prompt_design');
    // Saving is the user's start: the version labels the dataset at once.
    if (state.facts.settingsConfirmed && state.examples.length) void scoreVersion({projectId, promptVersionId: v.id}).catch(() => undefined);
    await go(href('/prompt-design', {v: v.id}));
  };
  const discard = async () => {
    await closeDraft(projectId, proposal?.id ?? null, 'discarded').catch(() => undefined);
    setProposal(null);
    setDraft(base);
  };

  const empty = !current && !started;
  return (
    <Frame head={<PageTitle title={t('Prompt Design')} subtitle={t('Tell the AI about the task. It writes the prompt on the left.')} />} chat={empty ? {first: FIRST, chips: STARTERS, placeholder: 'Describe the task, or paste a doc link…'} : {placeholder: 'Describe the task, or paste a doc link…'}}>
      <Card padding={0}>
        <Toolbar
          label={t('Prompt actions')}
          dividers={['bottom']}
          startContent={
            <HStack gap={3} vAlign="center">
              <Icon icon={DocumentTextIcon} size="sm" color="secondary" />
              <VStack gap={0}>
                <Text type="label" weight="semibold">
                  {card ? t('Prompt {version}', {version: card.label}) : t('New prompt')}
                </Text>
                <Text type="supporting" color="secondary">
                  {status}
                </Text>
              </VStack>
            </HStack>
          }
          endContent={
            <>
              {shown.length > 0 && card && <DropdownMenu button={{label: card.label, variant: 'ghost', size: 'sm'}} menuMaxHeight={360} items={shown.map(s => ({label: s.label, href: href('/prompt-design', {v: s.version!.id})}))} />}
              {started && <CopyButton prompt={draft} />}
              {(dirty || (!current && proposal)) && <Button label={t('Discard')} variant="ghost" size="sm" clickAction={action(t('Discard'), discard)} />}
              <Button
                label={t('Save')}
                variant="primary"
                size="sm"
                icon={<Icon icon={CheckIcon} size="sm" />}
                isDisabled={!dirty || issues.length > 0}
                tooltip={issues[0] ? tm(issues[0].msg) : undefined}
                clickAction={action(t('Save'), save)}
              />
            </>
          }
        />
        {empty ? (
          <div className="sp-pd-empty">
            <EmptyState icon={<Icon icon={DocumentTextIcon} size="md" color="secondary" />} title={t('The prompt appears here')} description={t('Tell the AI about the task on the right. It writes the prompt here for you to check.')} />
          </div>
        ) : (
          <div className="sp-pd-body">
            <VStack gap={6}>
              <SegmentedControl label={t('View')} size="sm" value={view} onChange={v => {
                setView(v as typeof view);
                if (v === 'full') track('full_prompt_opened', {});
              }}>
                <SegmentedControlItem value="sections" label={t('Sections')} />
                {against && <SegmentedControlItem value="changes" label={t('Changes')} />}
                <SegmentedControlItem value="full" label={t('Full prompt')} />
              </SegmentedControl>
              {proposal && proposal.payload.unmapped.length > 0 && <NotCarriedOver list={proposal.payload.unmapped} />}
              {view === 'full' ? (
                <CodeBlock code={compilePrompt(draft)} language="xml" isWrapped size="sm" onCopy={() => track('prompt_copied', {from: 'dialog'})} />
              ) : view === 'changes' && against ? (
                <VStack gap={4}>
                  <Text type="supporting" color="secondary">
                    {t('Compared with {version}', {version: against.name})}
                  </Text>
                  <ChangesView prompt={draft} base={against.prompt} reasons={dirty && proposal ? proposal.payload.changes : undefined} />
                </VStack>
              ) : (
                <SectionsView prompt={draft} onEdit={setPart} />
              )}
            </VStack>
          </div>
        )}
      </Card>
      {part && <PartDialog part={part} prompt={draft} onSave={setDraft} onClose={() => setPart(null)} />}
      {confirm?.kind === 'stop' && card && (
        <FormDialog
          title={t("Stop {version}'s run?", {version: card.label})}
          width={480}
          onClose={() => setConfirm(null)}
          footer={
            <>
              <Button label={t('Keep editing')} variant="ghost" onClick={() => setConfirm(null)} />
              <Button label={t('Stop and save')} variant="primary" clickAction={action(t('Stop and save'), checkCleared)} />
            </>
          }
        >
          <Text type="body" color="secondary">
            {t('{version} is still answering ({percent}%). Saving stops it, and {version} runs again with your changes.', {version: card.label, percent: confirm.percent})}
          </Text>
        </FormDialog>
      )}
      {confirm?.kind === 'clear' && (
        <FormDialog
          title={confirm.n === 1 ? t('Clear 1 gold label?') : t('Clear {n} gold labels?', {n: num(confirm.n)})}
          width={520}
          onClose={() => setConfirm(null)}
          footer={
            <>
              <Button label={t('Keep editing')} variant="ghost" onClick={() => setConfirm(null)} />
              <Button label={confirm.n === 1 ? t('Save and clear 1 label') : t('Save and clear {n} labels', {n: num(confirm.n)})} variant="primary" clickAction={action(t('Save'), commit)} />
            </>
          }
        >
          <VStack gap={3}>
            <Text type="body" color="secondary">
              {confirm.removed.length
                ? t('You removed {values}. {n} examples have a gold label that no longer fits.', {values: confirm.removed.join(', '), n: num(confirm.n)})
                : t('You changed the label. {n} examples have a gold label that no longer fits.', {n: num(confirm.n)})}
            </Text>
            <Text type="body" color="secondary">
              {t('Their labels are cleared and they go back to Unlabeled in their label sets. The labeler sees the old label as a hint.')}
            </Text>
          </VStack>
        </FormDialog>
      )}
    </Frame>
  );
}

/** "v2", or "an earlier save of v3" for a save in the same major. */
function nameOf(v: PromptVersion, shown: ShownVersion[]): string {
  const s = shown.find(x => x.major === v.major);
  if (!s || s.version?.id === v.id) return s?.label ?? versionLabel(v);
  return t('an earlier save of {version}', {version: s.label});
}

function CopyButton({prompt}: {prompt: StructuredPrompt}) {
  const [copied, copy] = useCopy();
  const text = compilePrompt(prompt);
  return (
    <IconButton
      label={copied === text ? t('Copied') : t('Copy prompt')}
      variant="ghost"
      size="sm"
      icon={<Icon icon={copied === text ? CheckIcon : ClipboardDocumentIcon} size="sm" />}
      onClick={() => {
        copy(text);
        track('prompt_copied', {from: 'dialog'});
      }}
    />
  );
}

/** What an imported prompt holds that the parts have no place for: shown word for word, never dropped. */
function NotCarriedOver({list}: {list: string[]}) {
  return (
    <Card padding={4} variant="muted">
      <section aria-label={t('Not carried over')}>
      <VStack gap={2}>
        <HStack gap={2} vAlign="center">
          <StackItem size="fill">
            <Heading level={4}>{t('Not carried over')}</Heading>
          </StackItem>
        </HStack>
        <Text type="supporting" color="secondary">
          {t('These parts of your prompt have no place in the structured prompt. Move what matters into a definition or a rule.')}
        </Text>
        {list.map((text, i) => (
          <pre key={i} className="sp-pd-unmapped">
            {text}
          </pre>
        ))}
      </VStack>
      </section>
    </Card>
  );
}
