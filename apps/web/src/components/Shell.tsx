'use client';

import Link from 'next/link';
import {usePathname} from 'next/navigation';
import {createContext, Suspense, useCallback, useContext, useEffect, useMemo, useState, type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {NODES} from '@yushiguang/sprint-domain';
import type {NodeId, PageContext} from '@yushiguang/sprint-contracts';
import type {ProjectState} from '@/backend-api';
import {SignedIn} from './session';
import {ActionErrorBanner, clearActionError, Icon} from '@/ui';
import {t} from '@/i18n';
import {AskAi} from './AskAi';
import {ProjectProvider, useProject} from './ProjectContext';
import {SettingsProvider} from './ProjectSettings';
import {TopBar, type Where} from './shell/TopBar';
import {NoAccessHost} from './shell/NoAccess';

type Ctx = ReturnType<typeof useProject> & {state: ProjectState};

/** Where in a project a page is: a step, or the project overview. */
export type ProjectPlace = NodeId | 'overview';

interface Props {
  /** The step (the shell reads it from the address; kept for readers of the page). */
  node?: ProjectPlace;
  /** What Ask AI reads on this page. */
  page: PageContext;
  /** Ask AI starts open (Prompt Design, whose chat is part of the page). */
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
  /** Ask AI is rendered here: the right-hand panel under the top bar. */
  side: HTMLElement | null;
  /** Ask AI was just opened by the user: it slides in (motion M5). A page change keeps it still. */
  entering: boolean;
  /** Prompt Design: the chat is part of the page, open, with no close button. */
  pinned: boolean;
}
const ShellCtx = createContext<Shell>({open: false, setOpen: () => undefined, side: null, entering: false, pinned: false});
/** Opens Ask AI: every action that starts or continues a helper's work opens it, so the user lands where the helper works (R3-6). */
export function useOpenAskAi(): () => void {
  const {setOpen} = useContext(ShellCtx);
  return () => setOpen(true);
}
const PageCtx = createContext<PageContext>({label: '', agent: 'front_desk', intent: 'answer', context: {}});

/**
 * The frame of every page (wireframes v346): the one top bar with a full-width line under it, a
 * white page, and in a project the Ask AI panel on the right, under the top bar and full height.
 * The "insufficient access" dialog is mounted here once for the page.
 */
function AppFrame({
  where,
  askAi,
  side,
  setSide,
  sideShown,
  project,
  children,
}: {
  where: Where;
  askAi?: {open: boolean; toggle: () => void};
  side?: boolean;
  setSide?: (el: HTMLElement | null) => void;
  sideShown?: boolean;
  project?: {id: string; name: string};
  children: ReactNode;
}) {
  return (
    <div className="sp-app">
      <header className="sp-top">
        <TopBar where={where} askAi={askAi} />
      </header>
      <div className="sp-body">
        <main className="sp-main k">{children}</main>
        {side && <div className="sp-side k" ref={setSide} hidden={!sideShown} />}
      </div>
      <NoAccessHost project={project} />
    </div>
  );
}

/**
 * The shell of every project page, mounted once for all of them: the project state, the top bar
 * and the open state of Ask AI stay as they are while the user moves between steps, so a step
 * change never blanks the page. Until the project has loaded, the page shows a spinner.
 */
export function ProjectShell({children}: {children: ReactNode}) {
  return (
    <SignedIn>
      <Suspense fallback={<Loading />}>
        <ProjectProvider>
          <ShellInner>{children}</ShellInner>
        </ProjectProvider>
      </Suspense>
    </SignedIn>
  );
}

function ShellInner({children}: {children: ReactNode}) {
  const ctx = useProject();
  const place = placeFromPath(usePathname());
  const pinned = place === 'prompt_design';
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
  const shell = useMemo(() => ({open: open || pinned, setOpen, side, entering, pinned}), [open, pinned, setOpen, side, entering]);
  if (!ctx.projectId) return <Missing text={t('No project was chosen.')} />;
  if (ctx.error) return <Missing text={t(ctx.error)} />;
  const state = ctx.state?.project.id === ctx.projectId ? ctx.state : null;
  if (!state) return <Loading />;
  return (
    <ShellCtx.Provider value={shell}>
      <SettingsProvider state={state}>
        <AppFrame
          where={{project: state, current: place}}
          askAi={pinned ? undefined : {open, toggle: () => setOpen(!open)}}
          side
          setSide={setSide}
          sideShown={open || pinned}
          project={{id: state.project.id, name: state.project.name}}
        >
          {children}
        </AppFrame>
      </SettingsProvider>
    </ShellCtx.Provider>
  );
}

/** The step or overview a path belongs to; a step's sub-pages (a label set) belong to the step. */
const placeFromPath = (path: string): ProjectPlace => {
  const p = path.replace(/\/+$/, '');
  if (/\/overview$/.test(p)) return 'overview';
  return (NODES.find(n => p.endsWith(n.path) || p.includes(`${n.path}/`)) ?? NODES[0]).id;
};

/** The spinner shown while a page's data loads (design: "Step-Loading"). */
export function Loading() {
  return (
    <div className="k sp-loading" role="status" aria-label={t('Loading')}>
      <Icon name="ring" />
    </div>
  );
}

/** A project page: what Ask AI reads on it, and its content (a `<Frame>`). */
export function ProjectPage({page, chatOpen = false, children}: Props) {
  const ctx = useProject();
  const {setOpen} = useContext(ShellCtx);
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

/** A project page's header and content, centred (wireframes `Page`), with Ask AI in the right-hand panel when it is open. */
export function Frame({head, children, chat}: {head: ReactNode; children: ReactNode; chat?: ChatSlot}) {
  const {open, setOpen, side, entering, pinned} = useContext(ShellCtx);
  const page = useContext(PageCtx);
  // Motion M3: each page's body fades in when the route changes (the top bar stays put).
  const pathname = usePathname();
  const chatShown = usePresence(open, CHAT_OUT_MS);
  useEffect(() => () => clearActionError(), []);
  return (
    <>
      <PageBody head={head} fadeKey={pathname}>
        {children}
      </PageBody>
      {chatShown && side && createPortal(<AskAi page={page} entering={entering} leaving={!open} onClose={pinned ? undefined : () => setOpen(false)} {...chat} />, side)}
    </>
  );
}

function PageBody({head, fadeKey, children}: {head: ReactNode; fadeKey?: string; children: ReactNode}) {
  return (
    <div className="sp-page">
      <div className="sp-head">{head}</div>
      <div key={fadeKey} className="container page-in">
        <ActionErrorBanner />
        {children}
      </div>
    </div>
  );
}

/**
 * A page of the tenant, outside any project (the tenant page, data sources): the top bar without
 * steps, and the page body. Nothing renders until the signed-in user is known.
 */
export function TenantPage({head, children}: {head: ReactNode; children: ReactNode}) {
  return (
    <SignedIn>
      <AppFrame where={{tenant: true}}>
        <PageBody head={head}>{children}</PageBody>
      </AppFrame>
    </SignedIn>
  );
}

/** The home page's frame: the top bar names only Sprint. */
export function HomeFrame({children}: {children: ReactNode}) {
  return (
    <SignedIn>
      <AppFrame where={{home: true}}>{children}</AppFrame>
    </SignedIn>
  );
}

function Missing({text}: {text: string}) {
  return (
    <div className="k sp-missing">
      <h2>{text}</h2>
      <p>
        <Link href="/tenant/">{t('Back to all projects')}</Link>
      </p>
    </div>
  );
}
