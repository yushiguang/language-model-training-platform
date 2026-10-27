'use client';

import {useState} from 'react';
import {Badge} from '@astryxdesign/core/Badge';
import {Button} from '@astryxdesign/core/Button';
import {Icon} from '@astryxdesign/core/Icon';
import {SegmentedControl, SegmentedControlItem} from '@astryxdesign/core/SegmentedControl';
import {Selector} from '@astryxdesign/core/Selector';
import {TextArea} from '@astryxdesign/core/TextArea';
import {Check, Send, X} from 'lucide-react';
import {FactRows, IconLine} from '@/components/cards/CardFrame';
import {HelpTip} from '@/components/HelpTip';
import {useLocale} from '@/i18n/LocaleProvider';
import {t, type T} from '@/i18n/text';
import {FIELDS, RULES, valueOf, type Field} from '@/mock/fields';
import {schemaJson, type Schema} from '@/mock/schema';
import {useStory} from '@/story/StoryProvider';

const TYPE_HELP = {
  single: t('Single-select: each post gets exactly one value.', '单选：每条帖子只取一个值。'),
  multi: t('Multi-select: each post gets one or more values, within the limits shown.', '多选：每条帖子取一个或多个值，数量在所示范围内。'),
};

function parse(json: string): Schema | null {
  try {
    const value = JSON.parse(json) as Schema;
    return Array.isArray(value.label_fields) ? value : null;
  } catch {
    return null;
  }
}

/** A section heading with its explanation behind a circled question mark. */
function TermHeading({title, help}: {title: T; help: T}) {
  const {tr} = useLocale();
  return (
    <div className="term-heading">
      <h3>{tr(title)}</h3>
      <HelpTip text={tr(help)} label={tr(title)} />
    </div>
  );
}

/** One label field. Every field, single- or multi-select, is laid out the same way. */
function FieldSection({field, defaultId, onDefaultChange}: {field: Field; defaultId: string; onDefaultChange: (id: string) => void}) {
  const {tr} = useLocale();
  const type = field.kind === 'single' ? t('Single-select', '单选') : t(`Multi-select · ${field.range![0]} to ${field.range![1]}`, `多选 · ${field.range![0]} 到 ${field.range![1]} 个`);
  return (
    <section className="schema-field">
      <div className="schema-field-head">
        <h3>{tr(field.name)}</h3>
        <code>{field.id}</code>
        <span className="schema-type">
          <Badge label={tr(type)} variant="neutral" />
          <HelpTip text={tr(TYPE_HELP[field.kind])} label={tr(type)} />
        </span>
      </div>
      <p className="page-text">{tr(field.description)}</p>
      <div className="schema-field-meta">
        <div className="schema-default">
          <Selector
            label={tr(t('Default label', '默认标签'))}
            size="sm"
            value={defaultId}
            onChange={onDefaultChange}
            options={field.values.map(v => ({value: v.id, label: tr(v.name)}))}
            width={200}
          />
          <HelpTip text={tr(t('The label a post gets when none of the values fits.', '当所有取值都不符合时，帖子得到的标签。'))} label={tr(t('Default label', '默认标签'))} />
        </div>
        {field.order && (
          <div className="schema-order">
            <span className="setting-label">{tr(t('Check order', '判断顺序'))}</span>
            <span className="schema-order-list">{field.order.map(id => tr(valueOf(field.id, id).name)).join(' → ')}</span>
            <HelpTip text={tr(t('Values are checked in this order, and the first that fits wins.', '按这个顺序逐个判断，取第一个符合的。'))} label={tr(t('Check order', '判断顺序'))} />
          </div>
        )}
      </div>
      <div className="table-scroll">
        <table className="data-table value-table">
          <thead>
            <tr>
              <th scope="col">{tr(t('Value', '取值'))}</th>
              <th scope="col">{tr(t('Definition', '定义'))}</th>
            </tr>
          </thead>
          <tbody>
            {field.values.map(v => (
              <tr key={v.id}>
                <th scope="row">{tr(v.name)}</th>
                <td>
                  {v.definition && tr(v.definition)}
                  {(v.examples?.length || v.counterexamples?.length) && (
                    <ul className="examples">
                      {v.examples?.map(e => (
                        <li key={e.en}>
                          <IconLine icon={<Icon icon={Check} size="sm" color="success" label={tr(t('Example', '正例'))} />}>{tr(e)}</IconLine>
                        </li>
                      ))}
                      {v.counterexamples?.map(e => (
                        <li key={e.en}>
                          <IconLine icon={<Icon icon={X} size="sm" color="error" label={tr(t('Counterexample', '反例'))} />}>{tr(e)}</IconLine>
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * The schema, readable as a form or as JSON. Both views edit the same JSON, and edits go to
 * the agent, which owns the schema in the session.
 */
export function SchemaPanel() {
  const {tr} = useLocale();
  const story = useStory();
  const isConfirmed = story.isResolved('a-schema');
  const repost = story.state.choices['q-repost'];
  const sent = story.state.schemaEdits;
  const baseline = sent.length ? sent[sent.length - 1] : JSON.stringify(schemaJson(repost), null, 2);
  const [view, setView] = useState<'form' | 'json'>('form');
  const [json, setJson] = useState(baseline);
  const schema = parse(json);
  const isDirty = json !== baseline;

  const defaultOf = (field: Field) => {
    const name = schema?.label_fields.find(f => f.name === field.id)?.default;
    return field.values.find(v => v.name.en === name)?.id ?? field.defaultValue;
  };
  const setDefault = (field: Field, id: string) => {
    if (!schema) return;
    const next: Schema = {
      ...schema,
      label_fields: schema.label_fields.map(f => (f.name === field.id ? {...f, default: valueOf(field.id, id).name.en} : f)),
    };
    setJson(JSON.stringify(next, null, 2));
  };

  return (
    <div className="page">
      <div className="page-toolbar schema-toolbar">
        <SegmentedControl label={tr(t('View', '视图'))} size="sm" value={view} onChange={v => setView(v as 'form' | 'json')}>
          <SegmentedControlItem value="form" label={tr(t('Form', '表单'))} />
          <SegmentedControlItem value="json" label="JSON" />
        </SegmentedControl>
        <Badge label={tr(isConfirmed ? t('Confirmed', '已确认') : t('Draft', '草稿'))} variant={isConfirmed ? 'success' : 'neutral'} />
        {isDirty && (
          <div className="toolbar-end schema-edit-actions">
            <Button label={tr(t('Discard', '放弃修改'))} variant="ghost" size="sm" onClick={() => setJson(baseline)} />
            <Button
              label={tr(t('Send edits to the agent', '把修改发给智能体'))}
              variant="primary"
              size="sm"
              icon={<Icon icon={Send} size="sm" />}
              isDisabled={!schema}
              onClick={() => story.sendSchemaEdit(json)}
            />
          </div>
        )}
      </div>

      {view === 'json' ? (
        <div className="prompt-edit">
          <TextArea
            label={tr(t('Schema as JSON', 'Schema 的 JSON'))}
            isLabelHidden
            value={json}
            onChange={setJson}
            rows={30}
            status={schema ? undefined : {type: 'error', message: tr(t('This isn’t valid schema JSON yet.', '这还不是有效的 Schema JSON。'))}}
          />
        </div>
      ) : (
        <>
          {FIELDS.map(field => (
            <FieldSection key={field.id} field={field} defaultId={defaultOf(field)} onDefaultChange={id => setDefault(field, id)} />
          ))}

          <section className="schema-section">
            <TermHeading title={t('Rules', '规则')} help={t('From your prompt. They apply to every field.', '来自你的 Prompt，对所有字段生效。')} />
            <ol className="rules">
              {RULES.map(rule => (
                <li key={rule.en}>{tr(rule)}</li>
              ))}
            </ol>
          </section>

          {repost && (
            <section className="schema-section">
              <TermHeading title={t('Your rulings', '你的裁决')} help={t('Edge cases you decided in the chat. They become examples in the prompt.', '你在对话里决定的边界情况，会写进 Prompt 的示例。')} />
              <FactRows
                rows={[
                  {
                    label: tr(t('Reposted interview, no comment from the poster', '原样转发的访谈，发布者没有补充观点')),
                    value: tr(valueOf('primary_value', repost).name),
                  },
                ]}
              />
            </section>
          )}

          <section className="schema-section">
            <TermHeading
              title={t('Teacher-only fields', '仅教师模型字段')}
              help={t('The teacher writes these to reason better. The student only learns the label fields.', '教师模型写这些字段来帮助推理，学生模型只学标签字段。')}
            />
            <FactRows
              rows={[
                {label: 'summary', value: tr(t('What happens in the video, in one sentence', '一句话说明视频内容'))},
                {label: 'reasoning', value: tr(t('Why each field has its value, in two to four sentences', '用两到四句话说明每个字段为什么这样标'))},
              ]}
            />
          </section>
        </>
      )}
    </div>
  );
}
