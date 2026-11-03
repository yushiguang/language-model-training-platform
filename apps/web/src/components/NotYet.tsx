'use client';

import {Button} from '@/ui';

/** Shown when a page is opened before the step it depends on. */
export function NotYet({text, to}: {text: string; to: string}) {
  return (
    <div className="card">
      <p>{text}</p>
      <div>
        <Button label="Go there" variant="primary" href={to} />
      </div>
    </div>
  );
}
