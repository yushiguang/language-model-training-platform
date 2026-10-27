'use client';

import {useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {CheckboxList, CheckboxListItem} from '@astryxdesign/core/CheckboxList';
import {Icon} from '@astryxdesign/core/Icon';
import {RadioList, RadioListItem} from '@astryxdesign/core/RadioList';
import {CircleCheck, Eye, EyeOff, Pencil} from 'lucide-react';
import {IconLine} from '@/components/cards/CardFrame';
import {PostLabels, sameAnswer} from '@/components/PostLabels';
import {PostPreview} from '@/components/PostPreview';
import {ValueChip, ValueList} from '@/components/ValueChip';
import {useLocale} from '@/i18n/LocaleProvider';
import {t, type T} from '@/i18n/text';
import {FIELD_BY_ID, FIELDS, type FieldId, type FormatId, type LabelId, type TopicId} from '@/mock/fields';
import {LABELING_POSTS, POST_BY_ID, type Labels, type Post} from '@/mock/posts';
import {useStory} from '@/story/StoryProvider';
import {PanelSection, fieldKind} from './parts';

const MAX_TOPICS = FIELD_BY_ID.topics.range![1];

/** Everything the teacher wrote for the post: the label fields and its teacher-only summary and reasoning. */
function TeacherAnswer({post}: {post: Post}) {
  const {tr} = useLocale();
  const out = post.teacher;
  return (
    <div className="teacher-answer">
      <div className="teacher-answer-title">{tr(t('Teacher’s output (prompt v1)', '教师模型的输出（Prompt v1）'))}</div>
      <dl className="post-labels">
        <div className="post-labels-row">
          <dt>summary</dt>
          <dd>{tr(out.summary)}</dd>
        </div>
        <div className="post-labels-row">
          <dt>reasoning</dt>
          <dd>{tr(out.reasoning)}</dd>
        </div>
        {FIELDS.map(f => (
          <div key={f.id} className="post-labels-row">
            <dt>{f.id}</dt>
            <dd>
              <ValueList field={f.id} ids={out[f.id]} />
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** The user's labeling share: blind by default, three fields per post, editable until it goes to the agent. */
export function LabelingPanel() {
  const {tr} = useLocale();
  const story = useStory();
  const choice = story.state.choices['l-label'];
  const isAwaited = story.awaitedCardId === 'l-label';
  const posts = LABELING_POSTS.map(id => POST_BY_ID[id]);
  const mine = story.state.myLabels;
  const firstOpen = posts.findIndex(p => !mine[p.id]);
  // null shows the summary once every post is labeled; a number opens that post's form.
  const [open, setOpen] = useState<number | null>(firstOpen === -1 ? null : firstOpen);
  const isAllLabeled = firstOpen === -1;

  if (choice === 'skip' || (choice && !isAllLabeled)) {
    return (
      <div className="page">
        <IconLine className="page-status" icon={<Icon icon={CircleCheck} size="md" color="success" />}>
          {tr(t('You skipped your share. Mei and Ravi covered it.', '你跳过了这部分，Mei 和 Ravi 已补上。'))}
        </IconLine>
        <PanelSection title={t('Your posts and their gold labels', '你的帖子及其金标')}>
          <div className="answer-list">
            {posts.map(p => (
              <div key={p.id} className="answer-row">
                <div className="answer-title" dir="auto" lang={p.lang}>
                  {p.title}
                </div>
                <PostLabels labels={p.gold} />
              </div>
            ))}
          </div>
        </PanelSection>
      </div>
    );
  }

  const isSent = Boolean(choice);
  const nav = (
    <div className="post-nav" role="tablist" aria-label={tr(t('Your posts', '你的帖子'))}>
      {posts.map((p, i) => (
        <button
          key={p.id}
          type="button"
          role="tab"
          className="post-nav-item"
          aria-selected={open === i}
          onClick={() => setOpen(i)}
          disabled={isSent}>
          {mine[p.id] ? <Icon icon={CircleCheck} size="sm" color="success" /> : <span className="post-nav-dot" />}
          {tr(t(`Post ${i + 1}`, `第 ${i + 1} 条`))}
        </button>
      ))}
      {isAllLabeled && (
        <button type="button" role="tab" className="post-nav-item" aria-selected={open === null} onClick={() => setOpen(null)}>
          {tr(t('Review all', '查看全部'))}
        </button>
      )}
    </div>
  );

  if (open === null || isSent) {
    const matches = (f: FieldId) => posts.filter(p => sameAnswer(mine[p.id][f], p.teacher[f])).length;
    return (
      <div className="page">
        {!isSent && nav}
        <IconLine className="page-status" icon={<Icon icon={CircleCheck} size="md" color="success" />}>
          {tr(t('All 5 posts labeled', '5 条帖子已全部标注'))}
        </IconLine>
        <p className="page-text">
          {tr(
            t(
              `The teacher agreed with you on primary value for ${matches('primary_value')} of 5, format for ${matches('format')} and topics for ${matches('topics')}. Where you and the other labeler disagree, it goes to the disagreements page, not to the teacher’s side.`,
              `教师模型与你一致的：主要价值 ${matches('primary_value')}/5、形式 ${matches('format')}/5、话题 ${matches('topics')}/5。你和另一位标注员不一致的会进入分歧裁决，不会默认采用教师的答案。`,
            ),
          )}
        </p>
        <div className="answer-list">
          {posts.map((p, i) => (
            <div key={p.id} className="answer-row">
              <div>
                <div className="answer-title" dir="auto" lang={p.lang}>
                  {p.title}
                </div>
                {!isSent && <Button label={tr(t('Edit', '修改'))} variant="ghost" size="sm" icon={<Icon icon={Pencil} size="sm" />} onClick={() => setOpen(i)} />}
              </div>
              <PostLabels labels={mine[p.id]} compareTo={p.teacher} differsNote={tr(t('teacher differs', '教师不同'))} />
            </div>
          ))}
        </div>
        <div className="card-actions">
          {isSent ? (
            <IconLine className="resolved-note" icon={<Icon icon={CircleCheck} size="sm" color="success" />}>
              {tr(t('Sent to the agent', '已交给智能体'))}
            </IconLine>
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
      </div>
    );
  }

  const post = posts[open];
  return (
    <div className="page">
      {nav}
      <LabelForm
        key={post.id}
        post={post}
        initial={mine[post.id]}
        saveLabel={
          mine[post.id]
            ? t('Save changes', '保存修改')
            : posts.filter(p => !mine[p.id]).length === 1
              ? t('Save and finish', '保存并完成')
              : t('Save and next', '保存，下一条')
        }
        onSave={labels => {
          story.saveLabels(post.id, labels);
          const next = posts.findIndex((p, i) => i !== open && !mine[p.id]);
          setOpen(next === -1 ? null : next);
        }}
      />
    </div>
  );
}

function LabelForm({post, initial, saveLabel, onSave}: {post: Post; initial?: Labels; saveLabel: T; onSave: (labels: Labels) => void}) {
  const {tr} = useLocale();
  const [primary, setPrimary] = useState<LabelId | ''>(initial?.primary_value ?? '');
  const [format, setFormat] = useState<FormatId | ''>(initial?.format ?? '');
  const [topics, setTopics] = useState<TopicId[]>(initial?.topics ?? []);
  const [isRevealed, setIsRevealed] = useState(false);
  const isComplete = primary !== '' && format !== '' && topics.length > 0;
  const [primaryField, formatField, topicsField] = FIELDS;

  return (
      <div className="labeling">
        <div className="labeling-post">
          <div className="card-inset">
            <PostPreview post={post} />
          </div>
          {isRevealed ? (
            <>
              <TeacherAnswer post={post} />
              <div>
                <Button label={tr(t('Hide the teacher’s output', '隐藏教师模型的输出'))} variant="ghost" size="sm" icon={<Icon icon={EyeOff} size="sm" />} onClick={() => setIsRevealed(false)} />
              </div>
            </>
          ) : (
            <div className="reveal">
              <Button label={tr(t('Reveal the teacher’s output', '查看教师模型的输出'))} variant="secondary" size="sm" icon={<Icon icon={Eye} size="sm" />} onClick={() => setIsRevealed(true)} />
              <span className="reveal-hint">{tr(t('Labeling is blind; look only if you’re stuck.', '标注是盲标的，卡住时再看。'))}</span>
            </div>
          )}
        </div>
        <div className="labeling-form">
          <RadioList label={`${tr(primaryField.name)} · ${tr(fieldKind(primaryField))}`} value={primary} onChange={v => setPrimary(v as LabelId)}>
            {primaryField.values.map(v => (
              <RadioListItem key={v.id} value={v.id} label={<ValueChip field="primary_value" id={v.id} />} description={v.definition && tr(v.definition)} />
            ))}
          </RadioList>
          <RadioList label={`${tr(formatField.name)} · ${tr(fieldKind(formatField))}`} value={format} onChange={v => setFormat(v as FormatId)}>
            {formatField.values.map(v => (
              <RadioListItem key={v.id} value={v.id} label={tr(v.name)} description={v.definition && tr(v.definition)} />
            ))}
          </RadioList>
          <div className="topic-list">
            <CheckboxList label={`${tr(topicsField.name)} · ${tr(fieldKind(topicsField))}`} value={topics} onChange={v => setTopics((v as TopicId[]).slice(0, MAX_TOPICS))}>
              {topicsField.values.map(v => (
                <CheckboxListItem key={v.id} value={v.id} label={tr(v.name)} isDisabled={topics.length >= MAX_TOPICS && !topics.includes(v.id as TopicId)} />
              ))}
            </CheckboxList>
          </div>
          <div className="card-actions">
            <Button
              label={tr(saveLabel)}
              variant="primary"
              isDisabled={!isComplete}
              onClick={() => isComplete && onSave({primary_value: primary, format, topics})}
            />
            {!isComplete && <span className="reveal-hint">{tr(t('Answer all three fields to save.', '三个字段都填完才能保存。'))}</span>}
          </div>
        </div>
      </div>
  );
}
