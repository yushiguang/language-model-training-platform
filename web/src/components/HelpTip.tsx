'use client';

import {Icon} from '@astryxdesign/core/Icon';
import {Tooltip} from '@astryxdesign/core/Tooltip';
import {CircleHelp} from 'lucide-react';

/** A circled question mark that explains a term the system defines, on hover or tap. */
export function HelpTip({text, label}: {text: string; label: string}) {
  return (
    <Tooltip content={text} placement="above" touchTrigger="tap">
      <button type="button" className="help-tip" aria-label={`${label}: ${text}`}>
        <Icon icon={CircleHelp} size="sm" color="inherit" />
      </button>
    </Tooltip>
  );
}
