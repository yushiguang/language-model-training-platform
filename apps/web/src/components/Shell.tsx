'use client';

import Link from 'next/link';
import {usePathname} from 'next/navigation';
import {createContext, Suspense, useContext, useEffect, useMemo, useRef, useState, type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {NODES} from '@tsp/domain';
import type {NodeId, PageContext} from '@tsp/contracts';
import {getRuntimeInfo, type ProjectState} from '@/backend-api';
import {ActionErrorBanner, clearActionError, Icon} from '@/ui';
import {AskAi} from './AskAi';
import {ProjectProvider, useProject} from './ProjectContext';
import {stepStates} from './steps';

type Ctx = ReturnType<typeof useProject> & {state: ProjectState};

interface Props {
  /** The step (the shell reads it from the address; kept for readers of the page). */
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

interface Shell {
  open: boolean;
  setOpen: (o: boolean) => void;
  /** Ask AI is rendered here, beside the main column. */
  side: HTMLElement | null;
}
const ShellCtx = createContext<Shell>({
  open: false,
  setOpen: () => undefined,
  side: null,
});
const PageCtx = createContext<PageContext>({
  label: '',
  agent: 'front_desk',
  intent: 'answer',
  context: {},
});

/**
 * The shell of every project page (design: "Shell"), mounted once for all steps: a grey page with
 * the top island (project, steps, user; as wide as the content, and moving left with it when Ask
 * AI opens) and Ask AI at the bottom right. The project state and the open state of Ask AI stay
 * as they are across step changes; until the project has loaded, the panel shows a spinner.
 */
export function ProjectShell({children}: {children: ReactNode}) {
  return (
    <Suspense fallback={<Loading />}>
      <ProjectProvider>
        <ShellInner>{children}</ShellInner>
      </ProjectProvider>
    </Suspense>
  );
}

function ShellInner({children}: {children: ReactNode}) {
  const ctx = useProject();
  const [open, setOpen] = useState(false);
  const [side, setSide] = useState<HTMLElement | null>(null);
  const shell = useMemo(() => ({open, setOpen, side}), [open, side]);
  const node = nodeFromPath(usePathname());
  if (!ctx.projectId) return <Missing text="No project was chosen." />;
  if (ctx.error) return <Missing text={ctx.error} />;
  const state = ctx.state?.project.id === ctx.projectId ? ctx.state : null;
  return (
    <ShellCtx.Provider value={shell}>
      <div className="k app b">
        <div className="b-body" ref={setSide}>
          <main className="b-main">
            {state ? <TopNav state={state} current={node} /> : <header className="topnav" />}
            {state ? children : <Loading panel />}
          </main>
        </div>
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

const nodeFromPath = (path: string): NodeId => {
  const p = path.replace(/\/+$/, '');
  return (NODES.find(n => p.endsWith(n.path)) ?? NODES[0]).id;
};

/** The spinner shown in the panel while a step's data loads (design: "Step-Loading"). */
export function Loading({panel}: {panel?: boolean}) {
  const spinner = (
    <div className="loading" role="status" aria-label="Loading">
      <Icon name="ring" />
    </div>
  );
  return panel ? <div className="container">{spinner}</div> : <div className="k app b">{spinner}</div>;
}

/** A step page: what Ask AI reads on it, and its content (a `<Frame>`). */
export function ProjectPage({page, chatOpen = false, children}: Props) {
  const ctx = useProject();
  const {setOpen} = useContext(ShellCtx);
  // A page that starts with Ask AI open (Schema settings) opens it; other pages keep it as it was.
  useEffect(() => {
    if (chatOpen) setOpen(true);
  }, [chatOpen, setOpen]);
  if (!ctx.state) return null;
  return <PageCtx.Provider value={page}>{children({...ctx, state: ctx.state})}</PageCtx.Provider>;
}

/** A page's header and content, with Ask AI beside them when it is open. */
export function Frame({head, children, chat}: {head: ReactNode; children: ReactNode; chat?: ChatSlot}) {
  const {open, setOpen, side} = useContext(ShellCtx);
  const page = useContext(PageCtx);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 0);
    on();
    window.addEventListener('scroll', on, {passive: true});
    return () => {
      window.removeEventListener('scroll', on);
      clearActionError();
    };
  }, []);
  return (
    <>
      <div className={`b-head${scrolled ? ' scrolled' : ''}`}>
        <div className="container">{head}</div>
      </div>
      <div className="container page-in">
        <ActionErrorBanner />
        {children}
      </div>
      {open && side && createPortal(<AskAi page={page} onClose={() => setOpen(false)} {...chat} />, side)}
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
