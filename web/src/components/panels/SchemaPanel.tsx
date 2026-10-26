'use client';

import {Badge} from '@astryxdesign/core/Badge';
import {Icon} from '@astryxdesign/core/Icon';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {Text} from '@astryxdesign/core/Text';
import {Check, X} from 'lucide-react';
import {FactRows} from '@/components/cards/CardFrame';
import {LabelChip} from '@/components/LabelChip';
import {useLocale} from '@/i18n/LocaleProvider';
import {t} from '@/i18n/text';
import {JUDGMENT_ORDER, LABELS, type LabelId} from '@/mock/labels';
import {useStory} from '@/story/StoryProvider';
import {PanelSection} from './parts';

export function SchemaPanel() {
  const {tr} = useLocale();
  const story = useStory();
  const isConfirmed = story.isResolved('a-schema');
  const repost = story.state.choices['q-repost'] as LabelId | undefined;
  const vlog = story.state.choices['q-adj'] as LabelId | undefined;

  const rulings = [
    repost && {label: tr(t('Reposted interview, no comment from the poster', '原样转发的访谈，发布者没有补充观点')), value: <LabelChip id={repost} />},
    vlog && {label: tr(t('Personal story as a vlog, with specifics others can respond to', '用 vlog 讲个人经历，带有别人可以回应的细节')), value: <LabelChip id={vlog} />},
  ].filter(Boolean) as {label: string; value: React.ReactNode}[];

  return (
    <VStack gap={6}>
      <HStack gap={2} align="center" wrap="wrap">
        <Badge label={tr(isConfirmed ? t('v1 · confirmed', 'v1 · 已确认') : t('v1 · draft', 'v1 · 草稿'))} variant={isConfirmed ? 'success' : 'neutral'} />
        <Text type="supporting" color="secondary">
          {tr(t('One field, label, with a single choice of four labels. Drafted from your teacher prompt.', '一个字段 label，四选一。根据你的教师 Prompt 起草。'))}
        </Text>
      </HStack>

      <PanelSection title={t('Labels', '标签')}>
        <div className="schema-labels">
          {LABELS.map(label => (
            <div key={label.id} className="schema-label">
              <LabelChip id={label.id} />
              <Text>{tr(label.definition)}</Text>
              <ul className="examples">
                {label.examples.map(e => (
                  <li key={e.en}>
                    <Icon icon={Check} size="sm" color="success" label={tr(t('Example', '正例'))} />
                    <span>{tr(e)}</span>
                  </li>
                ))}
                {label.counterexamples.map(e => (
                  <li key={e.en}>
                    <Icon icon={X} size="sm" color="error" label={tr(t('Counterexample', '反例'))} />
                    <span>{tr(e)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </PanelSection>

      <PanelSection
        title={t('Judgment order', '判断顺序')}
        description={t('From your prompt: the teacher checks the labels in this order and takes the first that fits.', '来自你的 Prompt：教师模型按这个顺序判断，取第一个符合的标签。')}>
        <ol className="judgment-order">
          {JUDGMENT_ORDER.map(id => (
            <li key={id}>
              <LabelChip id={id} />
            </li>
          ))}
        </ol>
      </PanelSection>

      {rulings.length > 0 && (
        <PanelSection title={t('Your rulings', '你的裁决')} description={t('Edge cases you decided in the chat. They become examples in the prompt.', '你在对话里决定的边界情况，会写进 Prompt 的示例。')}>
          <FactRows rows={rulings} />
        </PanelSection>
      )}

      <PanelSection
        title={t('Teacher-only fields', '仅教师模型字段')}
        description={t('The teacher writes these to reason better. The student only learns the label.', '教师模型写这些字段来帮助推理，学生模型只学习 label。')}>
        <FactRows
          rows={[
            {label: 'summary', value: tr(t('What the post is about, in one sentence', '一句话概括帖子内容'))},
            {label: 'reasoning', value: tr(t('Why the label fits, checked against the judgment order', '按判断顺序说明为什么选这个标签'))},
          ]}
        />
      </PanelSection>
    </VStack>
  );
}
