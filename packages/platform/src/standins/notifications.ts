import type {Notification, NotificationPort} from '@yushiguang/sprint-contracts';

/**
 * Stand-in for the company's instant-message tool (docs/design/server.md, 8): writes each
 * notification to the console and keeps the last `keep` in memory (`sent()`), so the flow can be
 * tried and tested without one. A deployment supplies an adapter that sends cards.
 */
export function logNotifications(keep = 100, log: (line: string) => void = line => console.info(line)): NotificationPort & {sent(): Notification[]} {
  const sent: Notification[] = [];
  return {
    async send(n) {
      sent.push(n);
      if (sent.length > keep) sent.splice(0, sent.length - keep);
      log(`[notification] ${n.kind} to ${n.userIds.join(', ')}: ${n.text} (${n.link})`);
    },
    sent: () => [...sent],
  };
}
