'use client';

import {useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {Icon} from '@astryxdesign/core/Icon';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {ProgressBar} from '@astryxdesign/core/ProgressBar';
import {RadioList, RadioListItem} from '@astryxdesign/core/RadioList';
import {Text} from '@astryxdesign/core/Text';
import {CircleCheck, Eye} from 'lucide-react';
import {LabelChip} from '@/components/LabelChip';
import {PostPreview} from '@/components/PostPreview';
import {useLocale} from '@/i18n/LocaleProvider';
import {t} from '@/i18n/text';
import {LABELS, type LabelId} from '@/mock/labels';
import {LABELING_POSTS, POST_BY_ID} from '@/mock/posts';
import {useStory} from '@/story/StoryProvider';
import {PanelSection} from './parts';

/** The user's labeling share: blind by default, one post at a time, then handed back to the agent. */
export function LabelingPanel() {
  const {tr} = useLocale();
  const story = useStory();
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, LabelId>>({});
  const [draft, setDraft] = useState<LabelId | ''>('');
  const [isRevealed, setIsRevealed] = useState(false);

  const choice = story.state.choices['l-label'];
  const isAwaited = story.awaitedCardId === 'l-label';
  const posts = LABELING_POSTS.map(id => POST_BY_ID[id]);
  const isFinished = index >= posts.length;

  if (choice && Object.keys(answers).length === 0) {
    return (
      <VStack gap={4}>
        <HStack gap={2} align="center">
          <Icon icon={CircleCheck} size="md" color="success" />
          <Text weight="semibold">
            {tr(choice === 'skip' ? t('You skipped your share. Mei and Ravi covered it.', '你跳过了这部分，Mei 和 Ravi 已补上。') : t('Your 5 labels are in.', '你的 5 条标注已提交。'))}
          </Text>
        </HStack>
        <PanelSection title={t('Your posts and their gold labels', '你的帖子及其金标')}>
          <AnswerTable rows={posts.map(p => ({postId: p.id, title: p.title, lang: p.lang, label: p.gold}))} heading={t('Gold label', '金标')} />
        </PanelSection>
      </VStack>
    );
  }

  if (isFinished) {
    const matches = posts.filter(p => answers[p.id] === p.teacher).length;
    return (
      <VStack gap={4}>
        <HStack gap={2} align="center">
          <Icon icon={CircleCheck} size="md" color="success" />
          <Text weight="semibold">{tr(t('All 5 posts labeled', '5 条帖子已全部标注'))}</Text>
        </HStack>
        <Text color="secondary">
          {tr(t(`The teacher agreed with you on ${matches} of 5. Disagreements go to adjudication, not to the teacher’s side.`, `教师模型和你一致的有 ${matches} 条。不一致的会进入裁决，不会默认采用教师的答案。`))}
        </Text>
        <AnswerTable rows={posts.map(p => ({postId: p.id, title: p.title, lang: p.lang, label: answers[p.id], teacher: p.teacher}))} heading={t('Your label', '你的标注')} />
        <div>
          {choice ? (
            <Text type="supporting" color="secondary">
              {tr(t('Sent to the agent.', '已交给智能体。'))}
            </Text>
          ) : (
            <Button
              label={tr(t('Send to the agent', '提交给智能体'))}
              variant="primary"
              isDisabled={!isAwaited}
              onClick={() => {
                story.resolve('l-label', 'done');
                story.closePanel();
              }}
            />
          )}
        </div>
      </VStack>
    );
  }

  const post = posts[index];
  const save = () => {
    if (!draft) return;
    setAnswers(a => ({...a, [post.id]: draft}));
    setDraft('');
    setIsRevealed(false);
    setIndex(i => i + 1);
  };

  return (
    <VStack gap={4}>
      <VStack gap={1}>
        <Text type="supporting" color="secondary" hasTabularNumbers>
          {tr(t(`Post ${index + 1} of ${posts.length}`, `第 ${index + 1} / ${posts.length} 条`))}
        </Text>
        <ProgressBar label={tr(t('Labeling progress', '标注进度'))} isLabelHidden value={(index / posts.length) * 100} />
      </VStack>
      <div className="labeling">
        <div className="card-inset">
          <PostPreview post={post} />
        </div>
        <VStack gap={3}>
          <RadioList label={tr(t('Main value for viewers', '对观众的主要价值'))} value={draft} onChange={v => setDraft(v as LabelId)}>
            {LABELS.map(label => (
              <RadioListItem key={label.id} value={label.id} label={<LabelChip id={label.id} />} description={tr(label.definition)} />
            ))}
          </RadioList>
          {isRevealed ? (
            <Text type="supporting" color="secondary">
              {tr(t('Teacher’s answer: ', '教师模型的答案：'))}
              <LabelChip id={post.teacher} />
            </Text>
          ) : (
            <div>
              <Button label={tr(t('Reveal the teacher’s answer', '查看教师模型的答案'))} variant="ghost" size="sm" icon={<Icon icon={Eye} size="sm" />} onClick={() => setIsRevealed(true)} />
            </div>
          )}
          <div>
            <Button label={tr(index === posts.length - 1 ? t('Save and finish', '保存并完成') : t('Save and next', '保存，下一条'))} variant="primary" isDisabled={!draft} onClick={save} />
          </div>
        </VStack>
      </div>
    </VStack>
  );
}

function AnswerTable({rows, heading}: {rows: {postId: string; title: string; lang: string; label: LabelId; teacher?: LabelId}[]; heading: {en: string; zh: string}}) {
  const {tr} = useLocale();
  const hasTeacher = rows.some(r => r.teacher);
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">{tr(t('Post', '帖子'))}</th>
            <th scope="col">{tr(heading)}</th>
            {hasTeacher && <th scope="col">{tr(t('Teacher', '教师模型'))}</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.postId}>
              <td dir="auto" lang={r.lang} className="cell-title">
                {r.title}
              </td>
              <td>
                <LabelChip id={r.label} />
              </td>
              {hasTeacher && <td>{r.teacher && <LabelChip id={r.teacher} />}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
