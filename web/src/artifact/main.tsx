import {createRoot} from 'react-dom/client';
import '@/app/globals.css';
import {Providers} from '@/app/providers';
import {Shell} from '@/components/Shell';
import {Workspace} from '@/components/Workspace';

// Entry for the single-file build that is shared as a private link; the Next app is the same tree.
createRoot(document.getElementById('root')!).render(
  <Providers>
    <Shell>
      <Workspace />
    </Shell>
  </Providers>,
);
