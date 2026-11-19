import type {BffContract, ItemProblem, RawExample} from '@yushiguang/sprint-contracts';

/**
 * Golden BFF fixtures (`apps/bff/fixtures/*.json`): sequences of `BffContract` calls over a small
 * world, with the result each call must give, as plain JSON. Any implementation of the BFF (and
 * the workflow behind it) can be held to them; `fixtures.test.ts` replays them on this one. The
 * format is described in `apps/bff/fixtures/README.md`. Pure code: no storage, no clock.
 */

/** A signed-in user of the world. Their organization is their tenant. */
export interface FixtureUser {
  id: string;
  name: string;
  organization?: string;
}

/** What the platform and the model know before the first call. */
export interface FixtureWorld {
  /** The users the steps act as, by name. The first one is the default. */
  users: Record<string, FixtureUser>;
  /** The items the feature port knows, by item id. Any other id is not found. */
  items?: Record<string, Omit<RawExample, 'externalId'>>;
  /** Items the platform's checks leave out, with the reason. */
  problems?: Record<string, ItemProblem>;
  /** The sample data that ships with the platform. */
  builtIn?: {name: string; ids: string[]};
  /** The model's reply to every labeling call, unless a `replies` entry matches. */
  reply: string;
  /** Replies for calls whose prompt contains `when` (the first match wins). */
  replies?: {when: string; text: string}[];
  /** Records stored as they are before the first call, by collection. */
  records?: Record<string, Record<string, unknown>[]>;
}

/** One call, and what it must give. */
export interface CallStep {
  /** A `BffContract` method. */
  call: keyof BffContract;
  /** Its arguments. A `$id:N` string (also inside a longer string) is the id the run gave that name. */
  args?: unknown[];
  /** The user it is made as (a key of `world.users`); the default user when left out. */
  as?: string;
  /** Keep only these parts of the result: dotted paths; a path ending in `#` is that array's length (`#` alone: the result's). */
  only?: string[];
  /** The normalized result. Left out when the call returns nothing. */
  expect?: unknown;
  /** The call must fail, with a message containing this text (after normalization). */
  expectError?: string;
  /** Why the step is there. */
  note?: string;
}

/** Wait until every queued job has finished (labeling, imports, taking examples). */
export interface SettleStep {
  settle: true;
  note?: string;
}

export type FixtureStep = CallStep | SettleStep;

export interface BffFixture {
  /** The case in one line. */
  name: string;
  /** The guards and behaviours the case holds an implementation to, in words. */
  guards: string[];
  world: FixtureWorld;
  steps: FixtureStep[];
}

/** What a step gave, normalized: its result, or its error. */
export type StepOutcome = {expect?: unknown} | {expectError: string};

/** A generated id: a short prefix and 16 random characters (`newId` in the domain package). */
const ID = /\b[a-z]{1,8}(?:_[a-z]{1,8})?_[0-9a-z]{16}\b/g;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * Names generated ids and times so that two runs (or two implementations) can be compared: each
 * new id becomes `$id:N`, numbered in the order the run first shows it, and every ISO time becomes
 * `$time`. Objects are walked in key order, so the numbering does not depend on key order.
 */
export class Normalizer {
  private readonly names = new Map<string, string>();
  private readonly ids = new Map<string, string>();

  /** The id a `$id:N` name stands for. */
  id(name: string): string {
    const id = this.ids.get(name);
    if (!id) throw new Error(`${name} has not been seen yet`);
    return id;
  }

  text(s: string): string {
    if (TIME.test(s)) return '$time';
    return s.replace(ID, id => {
      let name = this.names.get(id);
      if (!name) {
        name = `$id:${this.names.size + 1}`;
        this.names.set(id, name);
        this.ids.set(name, id);
      }
      return name;
    });
  }

  value(v: unknown): unknown {
    if (typeof v === 'string') return this.text(v);
    if (Array.isArray(v)) return v.map(x => this.value(x));
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) {
        const x = (v as Record<string, unknown>)[k];
        if (x !== undefined) out[this.text(k)] = this.value(x);
      }
      return out;
    }
    return v;
  }

  /** Arguments with each `$id:N` replaced by the id it names. */
  args(v: unknown): unknown {
    if (typeof v === 'string') return v.replace(/\$id:\d+/g, name => this.id(name));
    if (Array.isArray(v)) return v.map(x => this.args(x));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [this.args(k) as string, this.args(x)]));
    return v;
  }
}

/** The parts of a result a step keeps (`only`). A missing part is null. */
export function pick(result: unknown, only: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const path of only) {
    const count = path.endsWith('#');
    let v: unknown = result;
    const base = count ? path.slice(0, -1) : path;
    for (const k of base ? base.split('.') : []) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined;
    out[path] = count ? (Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : null) : (v ?? null);
  }
  return out;
}

/**
 * Runs a fixture's steps on BFFs (one per user) and returns what each step gave, normalized.
 * `settle` waits for the implementation's queued work. The caller compares the outcomes with the
 * fixture's `expect` and `expectError` (or records them).
 */
export async function replay(fx: BffFixture, apiFor: (user: string) => BffContract, settle: () => Promise<void>): Promise<StepOutcome[]> {
  const norm = new Normalizer();
  const fallback = Object.keys(fx.world.users)[0];
  const out: StepOutcome[] = [];
  for (const step of fx.steps) {
    if ('settle' in step) {
      await settle();
      out.push({});
      continue;
    }
    const api = apiFor(step.as ?? fallback);
    const fn = api[step.call] as (...a: unknown[]) => Promise<unknown>;
    if (typeof fn !== 'function') throw new Error(`${String(step.call)} is not a BFF method`);
    try {
      const result = await fn(...((norm.args(step.args ?? []) as unknown[])));
      // A plain JSON round trip, as over HTTP: undefined fields are dropped.
      const plain = result === undefined ? undefined : JSON.parse(JSON.stringify(result));
      const kept = step.only && plain !== undefined ? pick(plain, step.only) : plain;
      out.push(kept === undefined ? {} : {expect: norm.value(kept)});
    } catch (e) {
      out.push({expectError: norm.text(e instanceof Error ? e.message : String(e))});
    }
  }
  return out;
}

/** A step's recorded outcome, in the shape `replay` returns. */
export function recorded(step: FixtureStep): StepOutcome {
  if ('settle' in step) return {};
  if (step.expectError != null) return {expectError: step.expectError};
  return 'expect' in step ? {expect: step.expect} : {};
}

/** The fixture with each step's outcome written in (recording). */
export function withOutcomes(fx: BffFixture, outcomes: StepOutcome[]): BffFixture {
  const steps = fx.steps.map((s, i) => {
    if ('settle' in s) return s;
    const {expect: _e, expectError: _x, ...rest} = s;
    return {...rest, ...outcomes[i]} as CallStep;
  });
  return {...fx, steps};
}
