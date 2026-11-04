'use client';

import Link from 'next/link';
import {Suspense, useEffect, useState, type ReactNode} from 'react';
import {NODES, nodeStatuses} from '@tsp/domain';
import type {NodeId, PageContext} from '@tsp/contracts';
import {getRuntimeInfo} from '@/backend-api';
import {Icon} from '@/ui';
import {Assistant} from './Assistant';
import {ProjectProvider, useProject} from './ProjectContext';

export type AssistantMode = 'docked' | 'collapsed' | 'hero';

interface Props {
  node: NodeId;
  page: PageContext;
  assistant?: AssistantMode;
  wide?: boolean;
  children: (ctx: ReturnType<typeof useProject> & {state: NonNullable<ReturnType<typeof useProject>['state']>}) => ReactNode;
  /** Replaces the main column (used by the chat-centred start of Setup). */
  hero?: ReactNode;
}

/** Every project page: header with the workflow stepper, the page, and the assistant panel. */
export function ProjectPage(props: Props) {
  return (
    <Suspense fallback={null}>
      <ProjectProvider>
        <ShellInner {...props} />
      </ProjectProvider>
    </Suspense>
  );
}

function ShellInner({node, page, assistant = 'collapsed', wide, children, hero}: Props) {
  const ctx = useProject();
  const [mode, setMode] = useState<AssistantMode>(assistant);
  useEffect(() => {
    setMode(assistant);
  }, [assistant]);
  const [user, setUser] = useState('');
  const [standIns, setStandIns] = useState<string[]>([]);
  useEffect(() => {
    getRuntimeInfo().then(info => {
      setUser(info.user.name);
      setStandIns(info.standIns);
    });
  }, []);

  if (!ctx.projectId) return <Missing text="No project was chosen." />;
  if (ctx.error) return <Missing text={ctx.error} />;
  if (!ctx.state) return <div className="app" />;
  const state = ctx.state;
  const statuses = nodeStatuses(state.facts);

  return (
    <div className="app">
      <header className="topbar">
        <Link className="brand" href="/">
          <span className="brand-mark" aria-hidden="true">
            TS
          </span>
          <span className="col" style={{gap: 0}}>
            <span className="small muted">Training Set Platform</span>
            <span style={{fontWeight: 600}}>{state.project.name}</span>
          </span>
        </Link>
        <nav aria-label="Workflow" className="stepper">
          {NODES.map((n, i) => {
            const st = statuses[n.id];
            const cls = ['step', n.optional ? 'optional' : '', st === 'done' ? 'done' : '', st === 'attention' ? 'attention' : ''].join(' ');
            return (
              <span key={n.id} className="row" style={{gap: 4}}>
                {i > 0 && <span className="step-line" aria-hidden="true" />}
                <Link className={cls} href={ctx.href(n.path)} aria-current={n.id === node ? 'page' : undefined}>
                  <span className="step-num">{st === 'done' && n.id !== node ? <Icon name="check" size={12} /> : i + 1}</span>
                  {n.label}
                  {n.optional && <span className="small">optional</span>}
                  {st === 'attention' && <span className="small">needs attention</span>}
                  {st === 'running' && <span className="small">running</span>}
                </Link>
              </span>
            );
          })}
        </nav>
        <div className="row" style={{gap: 12}}>
          {standIns.length > 0 && (
            <span className="standin" title={`Stand-ins: ${standIns.join(', ')}`}>
              Stand-in services
            </span>
          )}
          <span className="avatar" aria-label={user}>
            {user.slice(0, 1)}
          </span>
        </div>
      </header>
      <div className="body">
        {hero ? (
          <main className="main hero">{hero}</main>
        ) : (
          <main className="main">
            <div className={`page${wide ? ' wide' : ''}`}>{children({...ctx, state})}</div>
          </main>
        )}
        {!hero && mode === 'docked' && <Assistant page={page} onMinimise={() => setMode('collapsed')} />}
      </div>
      {!hero && mode === 'collapsed' && (
        <button className="fab" aria-label="Open the assistant" onClick={() => setMode('docked')}>
          <Icon name="sparkle" size={20} />
        </button>
      )}
    </div>
  );
}

function Missing({text}: {text: string}) {
  return (
    <div className="app">
      <div className="page">
        <h1>{text}</h1>
        <Link href="/">Back to all projects</Link>
      </div>
    </div>
  );
}
