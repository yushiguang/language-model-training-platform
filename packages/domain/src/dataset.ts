import type {Answer, Example, Schema} from '@tsp/contracts';
import {systemConfig} from './config.ts';
import {hashString} from './template.ts';

/**
 * Eval dataset rules of 1.0.0 (spec section 4): which half each example is in, and the label
 * balance diagnostics. Pure functions; the bff stores what they decide.
 */

type HalfInput = Pick<Example, 'id' | 'externalId'> & {optimiserHalf: boolean | null};

/**
 * Assigns examples to the two halves of the eval set (spec 1.0.0, 4.2): one half the Optimiser and
 * the helpers learn from, the other held out for scoring.
 *
 * - Before the holdout is locked (`locked` false) every example may move: gold-labeled examples are
 *   stratified by their rarest value, so each rare value lands in both halves, and the rest fill
 *   the halves evenly in a fixed order (a hash of the item id).
 * - Once locked (a helper or the Optimiser has read examples), every example keeps its half. Only
 *   examples with no half yet (`optimiserHalf` null: just appended) are placed, by the same rule.
 *   A held-out example never moves to the optimiser half.
 *
 * Returns the half of every example by id (true = the optimiser half). The same input always gives
 * the same answer.
 */
export function assignEvalHalves(examples: HalfInput[], gold: Record<string, Answer | undefined>, locked: boolean): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  const fixed = locked ? examples.filter(e => e.optimiserHalf != null) : [];
  for (const e of fixed) out[e.id] = e.optimiserHalf!;
  const free = examples.filter(e => !(e.id in out));

  // The rarest value of each labeled example, counted over every labeled example.
  const valueCount = new Map<string, number>();
  const keysOf = (a: Answer) => Object.entries(a).flatMap(([f, vs]) => vs.map(v => `${f}=${v}`));
  for (const e of examples) for (const k of gold[e.id] ? keysOf(gold[e.id]!) : []) valueCount.set(k, (valueCount.get(k) ?? 0) + 1);
  const stratum = (e: HalfInput) => {
    const a = gold[e.id];
    if (!a) return '';
    const keys = keysOf(a).sort((x, y) => (valueCount.get(x)! - valueCount.get(y)!) || (x < y ? -1 : 1));
    return keys[0] ?? '';
  };

  const total = {opt: 0, held: 0};
  const per = new Map<string, {opt: number; held: number}>();
  const add = (s: string, opt: boolean) => {
    const c = per.get(s) ?? {opt: 0, held: 0};
    if (opt) c.opt++;
    else c.held++;
    per.set(s, c);
    if (opt) total.opt++;
    else total.held++;
  };
  for (const e of fixed) add(stratum(e), e.optimiserHalf!);

  // Rare strata first, so the rarest values are split before the halves fill up; unlabeled last.
  const order = [...free].sort((a, b) => {
    const sa = stratum(a);
    const sb = stratum(b);
    if (!sa !== !sb) return sa ? -1 : 1;
    const ca = valueCount.get(sa) ?? Infinity;
    const cb = valueCount.get(sb) ?? Infinity;
    if (ca !== cb) return ca - cb;
    if (sa !== sb) return sa < sb ? -1 : 1;
    return hashString(a.externalId) < hashString(b.externalId) ? -1 : 1;
  });
  for (const e of order) {
    const s = stratum(e);
    const c = per.get(s) ?? {opt: 0, held: 0};
    // The half with fewer of this value; then the smaller half; then held out first, so a single
    // example of a value is scored on.
    const opt = c.opt !== c.held ? c.opt < c.held : total.opt !== total.held ? total.opt < total.held : false;
    out[e.id] = opt;
    add(s, opt);
  }
  return out;
}

/** One value's gold labels in the eval set, and what the balance check says about it. */
export interface ValueBalance {
  value: string;
  count: number;
  optimiser: number;
  heldOut: number;
  /** Fewer than 4 gold examples, or fewer than 2 in either half: one miss moves Macro-F1 a lot. */
  rare: boolean;
  /** More than 70% of the labeled examples (once 30 are labeled): downsampling is an option. */
  dominant: boolean;
}

export interface LabelBalance {
  labeled: number;
  unlabeled: number;
  fields: {field: string; kind: 'single' | 'multi'; values: ValueBalance[]}[];
}

/** The label balance and coverage card on Eval Dataset (spec 1.0.0, 4.3). */
export function labelBalance(schema: Schema, examples: Pick<Example, 'id' | 'optimiserHalf'>[], gold: Record<string, {answer: Answer} | undefined>): LabelBalance {
  const c = systemConfig().dataset;
  const labeled = examples.filter(e => !!gold[e.id]);
  return {
    labeled: labeled.length,
    unlabeled: examples.length - labeled.length,
    fields: schema.fields.map(f => ({
      field: f.name,
      kind: f.kind,
      values: f.values.map(v => {
        const has = labeled.filter(e => (gold[e.id]!.answer[f.name] ?? []).includes(v.name));
        const optimiser = has.filter(e => e.optimiserHalf).length;
        const heldOut = has.length - optimiser;
        return {
          value: v.name,
          count: has.length,
          optimiser,
          heldOut,
          rare: has.length < c.rareValueMinCount || optimiser < c.rareValuePerHalfMin || heldOut < c.rareValuePerHalfMin,
          dominant: labeled.length >= c.dominantWarnMinLabeled && has.length / labeled.length > c.dominantValueShareWarn,
        };
      }),
    })),
  };
}

/**
 * Batch pruning (spec 1.0.0, 4.3): which examples to remove so that `candidates` keep `keep` of
 * them. Removes from the larger half first, in a fixed order, so the halves stay balanced; no
 * example changes half.
 */
export function pickToPrune(candidates: Pick<Example, 'id' | 'externalId' | 'optimiserHalf'>[], keep: number): string[] {
  const n = Math.max(0, candidates.length - Math.max(0, keep));
  const halves = {opt: candidates.filter(e => e.optimiserHalf), held: candidates.filter(e => !e.optimiserHalf)};
  for (const list of Object.values(halves)) list.sort((a, b) => (hashString(`prune|${a.externalId}`) < hashString(`prune|${b.externalId}`) ? -1 : 1));
  const out: string[] = [];
  while (out.length < n) {
    const from = halves.opt.length >= halves.held.length ? halves.opt : halves.held;
    out.push(from.shift()!.id);
  }
  return out;
}
