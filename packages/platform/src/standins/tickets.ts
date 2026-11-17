import type {TicketPort, TicketSubmission} from '@tsp/contracts';

const KEY = 'tsp-tickets';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** A ticket id the user can read out: "T-" and six letters or digits that are easy to tell apart. */
export function ticketId(): string {
  let s = 'T-';
  for (let i = 0; i < 6; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}

/**
 * Stand-in for the company's ticket system (spec 1.1.0, 3.3): keeps problem reports in this
 * browser (`localStorage`, or memory where there is none) so the flow can be tried end to end.
 */
export function localTickets(keep = 200): TicketPort & {list(): (TicketSubmission & {ticketId: string})[]} {
  const memory: (TicketSubmission & {ticketId: string})[] = [];
  const read = (): (TicketSubmission & {ticketId: string})[] => {
    if (typeof localStorage === 'undefined') return memory;
    try {
      return JSON.parse(localStorage.getItem(KEY) ?? '[]');
    } catch {
      return [];
    }
  };
  return {
    async submit(ticket) {
      const id = ticketId();
      const all = [...read(), {...ticket, ticketId: id}].slice(-keep);
      if (typeof localStorage === 'undefined') memory.splice(0, memory.length, ...all);
      else localStorage.setItem(KEY, JSON.stringify(all));
      return {ticketId: id};
    },
    list: read,
  };
}
