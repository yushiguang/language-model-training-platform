'use client';

import {Badge} from '@astryxdesign/core/Badge';
import {Icon} from '@astryxdesign/core/Icon';
import {Check, X} from 'lucide-react';
import {FactRows, IconLine} from '@/components/cards/CardFrame';
import {ValueChip} from '@/components/ValueChip';
import {useLocale} from '@/i18n/LocaleProvider';
import {t} from '@/i18n/text';
import {FIELDS, JUDGMENT_ORDER, LABELS, RULES, type Field} from '@/mock/fields';
import {useStory} from '@/story/StoryProvider';
import {PanelSection, fieldKind} from './parts';

function FieldHeading({field}: {field: Field}) {
  const {tr} = useLocale();
  return (
    <span className="field-tags">
      <code>{field.id}</code>
      <Badge label={tr(fieldKind(field))} variant="neutral" />
    </span>
  );
}

export function SchemaPanel() {
  const {tr} = useLocale();
  const story = useStory();
  const isConfirmed = story.isResolved('a-schema');
  const repost = story.state.choices['q-repost'];
  const [primary, format, topics] = FIELDS;

  return (
    <div className="page">
      <div className="page-lede">
        <Badge label={tr(isConfirmed ? t('v1 · confirmed', 'v1 · 已确认') : t('v1 · draft', 'v1 · 草稿'))} variant={isConfirmed ? 'success' : 'neutral'} />
        <span>
          {tr(t('Three label fields the student learns, drafted from your teacher prompt.', '学生模型要学的三个标签字段，根据你的教师 Prompt 起草。'))}
        </span>
      </div>

      <PanelSection title={primary.name} description={primary.description} aside={<FieldHeading field={primary} />}>
        <div className="value-cards">
          {LABELS.map(label => (
            <div key={label.id} className="value-card">
              <div className="value-card-name">
                <ValueChip field="primary_value" id={label.id} />
              </div>
              <p>{tr(label.definition)}</p>
              <ul className="examples">
                {label.examples.map(e => (
                  <li key={e.en}>
                    <IconLine icon={<Icon icon={Check} size="sm" color="success" label={tr(t('Example', '正例'))} />}>{tr(e)}</IconLine>
                  </li>
                ))}
                {label.counterexamples.map(e => (
                  <li key={e.en}>
                    <IconLine icon={<Icon icon={X} size="sm" color="error" label={tr(t('Counterexample', '反例'))} />}>{tr(e)}</IconLine>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="schema-order">
          <div className="schema-subhead">{tr(t('Judgment order: the first that fits wins', '判断顺序：取第一个符合的'))}</div>
          <ol className="order-list">
            {JUDGMENT_ORDER.map(id => (
              <li key={id}>
                <ValueChip field="primary_value" id={id} />
              </li>
            ))}
          </ol>
        </div>
      </PanelSection>

      <PanelSection title={format.name} description={format.description} aside={<FieldHeading field={format} />}>
        <FactRows rows={format.values.map(v => ({label: tr(v.name), value: v.definition ? tr(v.definition) : ''}))} />
      </PanelSection>

      <PanelSection title={topics.name} description={topics.description} aside={<FieldHeading field={topics} />}>
        <div className="chip-row">
          {topics.values.map(v => (
            <span key={v.id} className="tag">
              {tr(v.name)}
            </span>
          ))}
        </div>
      </PanelSection>

      <PanelSection title={t('Rules', '规则')} description={t('From your prompt. They apply to every field.', '来自你的 Prompt，对所有字段生效。')}>
        <ol className="rules">
          {RULES.map(rule => (
            <li key={rule.en}>{tr(rule)}</li>
          ))}
        </ol>
      </PanelSection>

      {repost && (
        <PanelSection title={t('Your rulings', '你的裁决')} description={t('Edge cases you decided in the chat. They become examples in the prompt.', '你在对话里决定的边界情况，会写进 Prompt 的示例。')}>
          <FactRows
            rows={[
              {
                label: tr(t('Reposted interview, no comment from the poster', '原样转发的访谈，发布者没有补充观点')),
                value: <ValueChip field="primary_value" id={repost} />,
              },
            ]}
          />
        </PanelSection>
      )}

      <PanelSection
        title={t('Teacher-only fields', '仅教师模型字段')}
        description={t('The teacher writes these to reason better. The student only learns the three label fields.', '教师模型写这些字段来帮助推理，学生模型只学三个标签字段。')}>
        <FactRows
          rows={[
            {label: 'summary', value: tr(t('What happens in the video, in one sentence', '一句话说明视频内容'))},
            {label: 'reasoning', value: tr(t('Why each field has its value, in two to four sentences', '用两到四句话说明每个字段为什么这样标'))},
          ]}
        />
      </PanelSection>
    </div>
  );
}
