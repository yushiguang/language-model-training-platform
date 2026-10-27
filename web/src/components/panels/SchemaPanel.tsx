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
import {defaultIn, outputSchema, withDefault, type Defaults, type OutputSchema} from '@/mock/schema';
import {titleCase} from '@/i18n/titleCase';
import {useStory} from '@/story/StoryProvider';

const NO_DEFAULT = '';

function parse(json: string): OutputSchema | null {
  try {
    const value = JSON.parse(json) as OutputSchema;
    return value && typeof value.properties === 'object' ? value : null;
  } catch {
    return null;
  }
}

const TEACHER_ONLY = [
  {
    id: 'summary',
    description: t('What happens in the video, in one sentence', '一句话说明视频内容'),
  },
  {
    id: 'reasoning',
    description: t('Why each field has its value, in two to four sentences', '用两到四句话说明每个字段为什么这样标'),
  },
];

/** A section heading with its explanation behind a circled question mark. */
function TermHeading({title, help}: {title: T; help: T}) {
  const {tr} = useLocale();
  return (
    <div className="term-heading">
      <h3>{titleCase(tr(title))}</h3>
      <HelpTip text={tr(help)} label={tr(title)} />
    </div>
  );
}

/** One label field. Every field, single- or multi-select, is laid out the same way. */
function FieldSection({field, defaultId, onDefaultChange}: {field: Field; defaultId?: string; onDefaultChange: (id: string | undefined) => void}) {
  const {tr} = useLocale();
  const type = field.kind === 'single' ? t('Single-select', '单选') : t(`Multi-select · ${field.range![0]} to ${field.range![1]}`, `多选 · ${field.range![0]} 到 ${field.range![1]} 个`);
  return (
    <section className="schema-field">
      <div className="schema-field-head">
        <h3>{titleCase(tr(field.name))}</h3>
        <code>{field.id}</code>
        <Badge label={tr(type)} variant="neutral" />
      </div>
      <p className="page-text">{tr(field.description)}</p>
      <div className="schema-default">
        <Selector
          label={tr(t('Default label', '默认标签'))}
          size="sm"
          value={defaultId ?? NO_DEFAULT}
          onChange={v => onDefaultChange(v === NO_DEFAULT ? undefined : v)}
          options={[{value: NO_DEFAULT, label: tr(t('No default', '不设默认'))}, ...field.values.map(v => ({value: v.id, label: tr(v.name)}))]}
          width={200}
        />
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
  const initialDefaults = Object.fromEntries(FIELDS.filter(f => f.defaultValue).map(f => [f.id, f.defaultValue])) as Defaults;
  const baseline = sent.length ? sent[sent.length - 1] : JSON.stringify(outputSchema(initialDefaults), null, 2);
  const [view, setView] = useState<'form' | 'json'>('form');
  const [json, setJson] = useState(baseline);
  const schema = parse(json);
  const isDirty = json !== baseline;

  const defaultOf = (field: Field) => (schema ? defaultIn(schema, field) : field.defaultValue);
  const setDefault = (field: Field, id: string | undefined) => {
    if (schema) setJson(JSON.stringify(withDefault(schema, field, id), null, 2));
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
            label={tr(t('Teacher output schema (JSON)', '教师输出 Schema（JSON）'))}
            isLabelHidden
            value={json}
            onChange={setJson}
            rows={30}
            description={tr(t('The JSON Schema used to parse and validate the teacher’s output.', '用于解析和校验教师输出的 JSON Schema。'))}
            status={
              schema
                ? undefined
                : {
                    type: 'error',
                    message: tr(t('This isn’t valid JSON Schema yet.', '这还不是有效的 JSON Schema。')),
                  }
            }
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
              <TermHeading
                title={t('Your rulings', '你的裁决')}
                help={t('Edge cases you decided in the chat. They become examples in the prompt.', '你在对话里决定的边界情况，会写进 Prompt 的示例。')}
              />
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
            <div className="table-scroll">
              <table className="data-table value-table">
                <thead>
                  <tr>
                    <th scope="col">{tr(t('Field', '字段'))}</th>
                    <th scope="col">{tr(t('Type', '类型'))}</th>
                    <th scope="col">{tr(t('Description', '说明'))}</th>
                  </tr>
                </thead>
                <tbody>
                  {TEACHER_ONLY.map(f => (
                    <tr key={f.id}>
                      <th scope="row">
                        <code>{f.id}</code>
                      </th>
                      <td>{tr(t('Text', '文本'))}</td>
                      <td>{tr(f.description)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
