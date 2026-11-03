import type {MixUp} from '@/core/types';

export const mixUpKey = (m: MixUp) => `${m.field}|${m.kind}|${m.gold}|${m.predicted}`;
export const mixUpText = (m: MixUp) => (m.kind === 'confused' ? `${m.gold} → ${m.predicted}` : m.kind === 'extra' ? `Extra: ${m.predicted}` : `Missed: ${m.gold}`);
export const mixUpHelp = (m: MixUp) => (m.kind === 'confused' ? `Correct answer ${m.gold}, model said ${m.predicted}` : m.kind === 'extra' ? 'Added when it did not apply' : 'Left out when it applied');
export const signed = (x: number) => (Math.abs(x) < 0.005 ? '0.00' : `${x > 0 ? '+' : '−'}${Math.abs(x).toFixed(2)}`);
