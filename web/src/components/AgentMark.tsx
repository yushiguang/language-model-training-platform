import {Sparkle} from 'lucide-react';

/** The agent's small mark: the product logo, and the sign that the agent is working. */
export function AgentMark({size = 16, isWorking = false}: {size?: number; isWorking?: boolean}) {
  return (
    <span className={isWorking ? 'agent-mark agent-mark-working' : 'agent-mark'} aria-hidden>
      <Sparkle size={size} strokeWidth={2} fill="currentColor" />
    </span>
  );
}
