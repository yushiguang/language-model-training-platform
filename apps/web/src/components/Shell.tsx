'use client';

import Link from 'next/link';
import {usePathname} from 'next/navigation';
import {createContext, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {LOCALES, NODES} from '@tsp/domain';
import type {NodeId, PageContext} from '@tsp/contracts';
import {getRuntimeInfo, type ProjectState} from '@/backend-api';
import {ActionErrorBanner, Button, clearActionError, Icon} from '@/ui';
import {t, useLocale} from '@/i18n';
import {AskAi} from './AskAi';
import {ProjectProvider, useProject} from './ProjectContext';
import {SettingsProvider, useSettings} from './ProjectSettings';
import {stepStates} from './steps';

type Ctx = ReturnType<typeof useProject> & {state: ProjectState};

interface Props {
  /** The step (the shell reads it from the address; kept for readers of the page). */
  node: NodeId;
  /** What Ask AI reads on this page. */
  page: PageContext;
  /** Ask AI starts open (Prompt Design, before the first prompt). */
  chatOpen?: boolean;
  /** Renders the page: its content is a `<Frame>`. */
  children: (ctx: Ctx) => ReactNode;
}

interface ChatSlot {
  chips?: string[];
  placeholder?: string;
  /** The agent's opening line, shown first. */
  first?: string;
}

interface Shell {
  open: boolean;
  setOpen: (o: boolean) => void;
  /** Ask AI is rendered here, beside the main column. */
  side: HTMLElement | null;
  /** Ask AI was just opened by the user: it slides in (motion M5). A page change keeps it still. */
  entering: boolean;
}
const ShellCtx = createContext<Shell>({
  open: false,
  setOpen: () => undefined,
  side: null,
  entering: false,
});
/** Opens Ask AI: every action that starts or continues a helper's work opens it, so the user lands where the helper works (R3-6). */
export function useOpenAskAi(): () => void {
  const {setOpen} = useContext(ShellCtx);
  return () => setOpen(true);
}
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
  const [open, setOpenState] = useState(false);
  const [entering, setEntering] = useState(false);
  const [side, setSide] = useState<HTMLElement | null>(null);
  const setOpen = useCallback((o: boolean) => {
    setOpenState(was => {
      if (o && !was) setEntering(true);
      return o;
    });
  }, []);
  useEffect(() => {
    if (!entering) return;
    const id = setTimeout(() => setEntering(false), 260);
    return () => clearTimeout(id);
  }, [entering]);
  const shell = useMemo(() => ({open, setOpen, side, entering}), [open, setOpen, side, entering]);
  const node = nodeFromPath(usePathname());
  if (!ctx.projectId) return <Missing text={t('No project was chosen.')} />;
  if (ctx.error) return <Missing text={t(ctx.error)} />;
  const state = ctx.state?.project.id === ctx.projectId ? ctx.state : null;
  return (
    <ShellCtx.Provider value={shell}>
     <SettingsProvider state={state}>
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
            {t('Ask AI')}
          </button>
        )}
      </div>
     </SettingsProvider>
    </ShellCtx.Provider>
  );
}

const nodeFromPath = (path: string): NodeId => {
  const p = path.replace(/\/+$/, '');
  // A step's sub-pages (the prompt editor at /prompt/edit) belong to the step.
  return (NODES.find(n => p.endsWith(n.path) || p.includes(`${n.path}/`)) ?? NODES[0]).id;
};

/** The spinner shown in the panel while a step's data loads (design: "Step-Loading"). */
export function Loading({panel}: {panel?: boolean}) {
  const spinner = (
    <div className="loading" role="status" aria-label={t('Loading')}>
      <Icon name="ring" />
    </div>
  );
  return panel ? <div className="container">{spinner}</div> : <div className="k app b">{spinner}</div>;
}

/** A step page: what Ask AI reads on it, and its content (a `<Frame>`). */
export function ProjectPage({page, chatOpen = false, children}: Props) {
  const ctx = useProject();
  const {setOpen} = useContext(ShellCtx);
  // A page that starts with Ask AI open (Prompt Design) opens it; other pages keep it as it was.
  useEffect(() => {
    if (chatOpen) setOpen(true);
  }, [chatOpen, setOpen]);
  if (!ctx.state) return null;
  return <PageCtx.Provider value={page}>{children({...ctx, state: ctx.state})}</PageCtx.Provider>;
}

const CHAT_OUT_MS = 200;

/** True while `on`, and for `ms` after it turns off (so an exit animation can play). */
function usePresence(on: boolean, ms: number): boolean {
  const [shown, setShown] = useState(on);
  useEffect(() => {
    if (on) return setShown(true);
    const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return setShown(false);
    const id = setTimeout(() => setShown(false), ms);
    return () => clearTimeout(id);
  }, [on, ms]);
  return on || shown;
}

/** A page's header and content, with Ask AI beside them when it is open. */
export function Frame({head, children, chat}: {head: ReactNode; children: ReactNode; chat?: ChatSlot}) {
  const {open, setOpen, side, entering} = useContext(ShellCtx);
  const page = useContext(PageCtx);
  // Motion M3: each step's body fades in when the route changes (the top island stays put).
  const pathname = usePathname();
  // Motion M5: Ask AI stays mounted while it slides out, so the page widens smoothly.
  const chatShown = usePresence(open, CHAT_OUT_MS);
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
      <div key={pathname} className="container page-in">
        <ActionErrorBanner />
        {children}
      </div>
      {chatShown && side && createPortal(<AskAi page={page} entering={entering} leaving={!open} onClose={() => setOpen(false)} {...chat} />, side)}
    </>
  );
}

function TopNav({state, current}: {state: ProjectState; current: NodeId}) {
  const {href} = useProject();
  const st = stepStates(state);
  return (
    <header className="topnav">
      <div className="island">
        <Link className="proj" href="/" title={t('All projects')}>
          <span className="proj-ic" aria-hidden="true">
            {state.project.name.trim().slice(0, 1).toUpperCase()}
          </span>
          <b title={state.project.name}>{state.project.name}</b>
        </Link>
        <nav className="stepper" aria-label={t('Workflow')}>
          {NODES.map((n, i) => {
            const s = st[n.id];
            return (
              <span key={n.id} style={{display: 'contents'}}>
                {i > 0 && <span className="step-sep" aria-hidden="true" />}
                <Link className={`step${s === 'todo' ? '' : ` ${s}`}`} aria-current={n.id === current ? 'page' : undefined} href={href(n.path)}>
                  <span className="step-ic">{s === 'done' ? <Icon name="check" /> : s === 'running' ? <Icon name="ring" /> : s === 'attention' ? '!' : i + 1}</span>
                  {t(n.label)}
                </Link>
              </span>
            );
          })}
        </nav>
        <UserEnd settings />
      </div>
    </header>
  );
}

/** The right end of the top island: the stand-in tag (while stand-ins run), Settings inside a project, and the user's avatar. */
export function UserEnd({settings}: {settings?: boolean}) {
  const {open} = useSettings();
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
        <span className="standin" title={t('Stand-ins: {list}', {list: standIns.map(x => t(x)).join(', ')})}>
          {t('Stand-in services')}
        </span>
      )}
      {settings && <Button label={t('Settings')} kind="ghost" size="sm" icon="settings" title={t('Project Settings: the name, the pass rule and the labeling model')} onClick={open} />}
      <UserMenu user={user} />
    </div>
  );
}

/** The user's avatar: a small menu with the user's name and the language choice (spec 1.1.0, 2.2). */
function UserMenu({user}: {user: string}) {
  const {locale, setLocale} = useLocale();
  const [at, setAt] = useState<{top: number; right: number} | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!at) return;
    pop.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    const away = (e: MouseEvent) => !pop.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node) && setAt(null);
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setAt(null);
      btn.current?.focus();
    };
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', key);
    };
  }, [at]);
  const toggle = () => {
    const r = btn.current?.getBoundingClientRect();
    setAt(at || !r ? null : {top: r.bottom + 8, right: Math.max(8, window.innerWidth - r.right)});
  };
  return (
    <>
      <button ref={btn} type="button" className="avatar avatar-btn" aria-label={user ? t('{name}: account and language', {name: user}) : t('Account and language')} aria-haspopup="menu" aria-expanded={!!at} title={user} onClick={toggle}>
        {user.slice(0, 1).toUpperCase()}
      </button>
      {at &&
        createPortal(
          <div ref={pop} className="k menu-pop" role="menu" style={at}>
            <div className="menu-name one" title={user}>
              {user}
            </div>
            <div className="menu-l">{t('Language')}</div>
            {LOCALES.map(l => (
              <button
                key={l.id}
                type="button"
                role="menuitemradio"
                aria-checked={l.id === locale}
                lang={l.id === 'zh' ? 'zh-CN' : 'en'}
                className="menu-i"
                onClick={() => {
                  setAt(null);
                  if (l.id !== locale) setLocale(l.id);
                }}
              >
                {l.name}
                {l.id === locale && <Icon name="check" />}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

function Missing({text}: {text: string}) {
  return (
    <div className="k app b">
      <div className="empty">
        <h2>{text}</h2>
        <p>
          <Link href="/">{t('Back to all projects')}</Link>
        </p>
      </div>
    </div>
  );
}
