'use client';

import Link from 'next/link';
import {createContext, Suspense, useContext, useEffect, useRef, useState, type ReactNode} from 'react';
import {NODES} from '@tsp/domain';
import type {NodeId, PageContext} from '@tsp/contracts';
import {getRuntimeInfo, type ProjectState} from '@/backend-api';
import {Icon} from '@/ui';
import {AskAi} from './AskAi';
import {ProjectProvider, useProject} from './ProjectContext';
import {stepStates} from './steps';

type Ctx = ReturnType<typeof useProject> & {state: ProjectState};

interface Props {
  node: NodeId;
  /** What Ask AI reads on this page. */
  page: PageContext;
  /** Ask AI starts open (Schema settings). */
  chatOpen?: boolean;
  /** Renders the page: its content is a `<Frame>`. */
  children: (ctx: Ctx) => ReactNode;
}

interface ChatSlot {
  /** Cards the page adds after the messages (a schema draft waiting for Approve). */
  extra?: ReactNode;
  chips?: string[];
  placeholder?: string;
  /** The agent's opening line, shown first. */
  first?: string;
  /** Runs before a message goes to the agent (Setup saves the first message as the task). */
  onSend?: (text: string) => Promise<void>;
}

const ShellCtx = createContext<{open: boolean; setOpen: (o: boolean) => void; page: PageContext; nav: ReactNode}>({open: false, setOpen: () => undefined, page: {label: '', agent: 'front_desk', intent: 'answer', context: {}}, nav: null});

/**
 * Every project page (design: "Shell"): a grey page with the top island (project, steps, user; as
 * wide as the content, and moving left with it when Ask AI opens), one fixed page header whose
 * content fades out under it while scrolled, and Ask AI at the bottom right.
 */
export function ProjectPage(props: Props) {
  return (
    <Suspense fallback={null}>
      <ProjectProvider>
        <ShellInner {...props} />
      </ProjectProvider>
    </Suspense>
  );
}

function ShellInner({node, page, chatOpen = false, children}: Props) {
  const ctx = useProject();
  const [open, setOpen] = useState(chatOpen);
  useEffect(() => setOpen(chatOpen), [chatOpen]);
  if (!ctx.projectId) return <Missing text="No project was chosen." />;
  if (ctx.error) return <Missing text={ctx.error} />;
  if (!ctx.state) return <div className="k app b" />;
  const state = ctx.state;
  return (
    <ShellCtx.Provider value={{open, setOpen, page, nav: <TopNav state={state} current={node} />}}>
      <div className="k app b">
        <div className="b-body">{children({...ctx, state})}</div>
        {!open && (
          <button type="button" className="ask" onClick={() => setOpen(true)}>
            <Icon name="spark" />
            Ask AI
          </button>
        )}
      </div>
    </ShellCtx.Provider>
  );
}

/** A page's header and content, with Ask AI beside them when it is open. */
export function Frame({head, children, chat}: {head: ReactNode; children: ReactNode; chat?: ChatSlot}) {
  const {open, setOpen, page, nav} = useContext(ShellCtx);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 0);
    on();
    window.addEventListener('scroll', on, {passive: true});
    return () => window.removeEventListener('scroll', on);
  }, []);
  return (
    <>
      <main className="b-main">
        {nav}
        <div className={`b-head${scrolled ? ' scrolled' : ''}`}>
          <div className="container">{head}</div>
        </div>
        <div className="container">{children}</div>
      </main>
      {open && <AskAi page={page} onClose={() => setOpen(false)} {...chat} />}
    </>
  );
}

function TopNav({state, current}: {state: ProjectState; current: NodeId}) {
  const {href} = useProject();
  const st = stepStates(state);
  return (
    <header className="topnav">
      <div className="island">
        <Link className="proj" href="/" title="All projects">
          <span className="proj-ic" aria-hidden="true">
            {state.project.name.trim().slice(0, 1).toUpperCase()}
          </span>
          <b title={state.project.name}>{state.project.name}</b>
        </Link>
        <nav className="stepper" aria-label="Workflow">
          {NODES.map((n, i) => {
            const s = st[n.id];
            return (
              <span key={n.id} style={{display: 'contents'}}>
                {i > 0 && <span className="step-sep" aria-hidden="true" />}
                <Link className={`step${s === 'todo' ? '' : ` ${s}`}`} aria-current={n.id === current ? 'page' : undefined} href={href(n.path)}>
                  <span className="step-ic">{s === 'done' ? <Icon name="check" /> : s === 'running' ? <Icon name="ring" /> : s === 'attention' ? '!' : i + 1}</span>
                  {n.label}
                  {n.optional && <span className="step-opt">optional</span>}
                </Link>
              </span>
            );
          })}
        </nav>
        <UserEnd />
      </div>
    </header>
  );
}

/** The right end of the top island: the stand-in tag (while stand-ins run) and the user's avatar. */
export function UserEnd() {
  const [user, setUser] = useState('');
  const [standIns, setStandIns] = useState<string[]>([]);
  const loaded = useRef(false);
  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    getRuntimeInfo().then(info => {
      setUser(info.user.name);
      setStandIns(info.standIns);
    });
  }, []);
  return (
    <div className="topbar-end">
      {standIns.length > 0 && (
        <span className="standin" title={`Stand-ins: ${standIns.join(', ')}`}>
          Stand-in services
        </span>
      )}
      <span className="avatar" aria-label={user} title={user}>
        {user.slice(0, 1).toUpperCase()}
      </span>
    </div>
  );
}

function Missing({text}: {text: string}) {
  return (
    <div className="k app b">
      <div className="empty">
        <h2>{text}</h2>
        <p>
          <Link href="/">Back to all projects</Link>
        </p>
      </div>
    </div>
  );
}
