'use client';

import Link from 'next/link';
import {Fragment, useEffect, useMemo, useState} from 'react';
import {Avatar, Button, DropdownMenu, type DropdownMenuOption, Icon, IconButton, Spinner, TextInput, TopNav, TopNavItem} from '@/ui/astryx';
import {ArrowRightIcon, ArrowRightStartOnRectangleIcon, CheckCircleIcon, ChevronDownIcon, LanguageIcon, MagnifyingGlassIcon, SparklesIcon} from '@heroicons/react/24/outline';
import {LOCALES, NODES} from '@yushiguang/sprint-domain';
import type {NodeId, Project} from '@yushiguang/sprint-contracts';
import {listProjects, listTenants, signOut, type ProjectState, type TenantSummary} from '@/backend-api';
import {t, useLocale} from '@/i18n';
import {useRuntime} from '../session';
import {hrefFor, tenantHref} from '../ProjectContext';
import {stepStates} from '../steps';
import {recentProjects, rememberProject} from './recent';

/** Where the top bar is: the home page, a tenant page, or a page of one project. */
export type Where = {home: true} | {tenant: true} | {project: ProjectState; current: NodeId | 'overview'};

interface AskAiControl {
  open: boolean;
  toggle: () => void;
}

/**
 * The one top bar of every page (wireframes v346, W-Overview): taller than Astryx's default, with
 * a full-width line under it. Left: 「Sprint / tenant / project」 (a switch arrow shows only on
 * hover, and only where there is something to switch to). Centre, in a project: the four steps,
 * no numbers, arrows between them, a tick on finished ones. Right: Ask AI (indigo, the only AI
 * colour; not on Prompt Design, whose chat is part of the page), language and the avatar.
 */
export function TopBar({where, askAi}: {where: Where; askAi?: AskAiControl}) {
  const inProject = 'project' in where;
  return (
    <TopNav
      label={t('Sprint navigation')}
      className="sp-topnav"
      startContent={<Crumbs where={where} />}
      centerContent={inProject ? <Steps state={where.project} current={where.current} /> : undefined}
      endContent={
        <span className="sp-end">
          {askAi && (
            <Button
              label={askAi.open ? t('Close Ask AI') : t('Ask AI')}
              variant={'ai' as never}
              className="sp-ask"
              size="sm"
              icon={<Icon icon={SparklesIcon} size="sm" />}
              onClick={askAi.toggle}
              aria-expanded={askAi.open}
            />
          )}
          <LanguageMenu />
          <AccountMenu />
        </span>
      }
    />
  );
}

function Crumbs({where}: {where: Where}) {
  const {info} = useRuntime();
  const tenant = info?.tenant;
  return (
    <span className="sp-crumbs">
      <Link className="sp-crumb" href="/">
        Sprint
      </Link>
      {!('home' in where) && (
        <>
          <span className="sp-sep" aria-hidden="true">
            /
          </span>
          <TenantSwitch name={tenant?.name} id={tenant?.id} here={'tenant' in where} />
        </>
      )}
      {'project' in where && (
        <>
          <span className="sp-sep" aria-hidden="true">
            /
          </span>
          <ProjectSwitch project={where.project.project} />
        </>
      )}
    </span>
  );
}

/**
 * The project name opens the switch menu (review M12, W-Switch): search, the projects opened most
 * recently (this one ticked), and All projects. Picking one opens its overview.
 */
function ProjectSwitch({project}: {project: Project}) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState<Project[] | null>(null);
  const [q, setQ] = useState('');
  useEffect(() => rememberProject(project.id), [project.id]);
  useEffect(() => {
    if (!open) return;
    setQ('');
    let live = true;
    listProjects().then(
      list => live && setAll(list),
      () => live && setAll([]),
    );
    return () => {
      live = false;
    };
  }, [open]);
  const shown = useMemo(() => {
    const list = all ?? [project];
    const needle = q.trim().toLowerCase();
    if (needle) return list.filter(p => p.name.toLowerCase().includes(needle)).slice(0, 8);
    return recentProjects(list, project.id).slice(0, 5);
  }, [all, q, project]);
  const items: DropdownMenuOption[] = [
    {
      type: 'section',
      title: q.trim() ? t('Projects') : t('Recent'),
      items: shown.length
        ? shown.map(p => ({id: p.id, label: p.name, href: hrefFor(p.id, '/overview'), endContent: p.id === project.id ? <Icon icon={CheckCircleIcon} size="sm" color="secondary" /> : undefined}))
        : [{id: 'none', label: t('No project matches'), isDisabled: true}],
    },
    {type: 'divider'},
    {id: 'all', label: t('All projects'), href: tenantHref(), endContent: <Icon icon={ArrowRightIcon} size="sm" color="secondary" />},
  ];
  return (
    <DropdownMenu
      isMenuOpen={open}
      onOpenChange={setOpen}
      menuWidth={320}
      menuMaxHeight={420}
      header={<TextInput label={t('Search projects')} isLabelHidden placeholder={t('Search projects')} value={q} onChange={setQ} size="sm" startIcon={MagnifyingGlassIcon} hasAutoFocus />}
      items={items}
      renderTrigger={props => (
        <button type="button" {...props} className="sp-crumb sp-crumb-project" title={project.name}>
          <span className="sp-crumb-name">{project.name}</span>
          <span className="sp-chev" aria-hidden="true">
            <Icon icon={ChevronDownIcon} size="xsm" color="secondary" />
          </span>
        </button>
      )}
    />
  );
}

/**
 * The tenant's name links to its tenant page (and on that page opens the menu); the arrow beside
 * it, shown on hover, opens the switch menu (#94): the user's tenants, this one ticked, and All
 * tenants (the home page).
 */
function TenantSwitch({name, id, here}: {name?: string; id?: string; here: boolean}) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<TenantSummary[] | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    listTenants().then(
      l => live && setList(l),
      () => live && setList([]),
    );
    return () => {
      live = false;
    };
  }, [open]);
  const mine = list ?? (id && name ? [{id, name}] : []);
  const items: DropdownMenuOption[] = [
    {
      type: 'section',
      title: t('Your tenants'),
      items: mine.map(x => ({id: x.id, label: x.name, href: tenantHref('/tenant/', x.id), endContent: x.id === id ? <Icon icon={CheckCircleIcon} size="sm" color="secondary" /> : undefined})),
    },
    {type: 'divider'},
    {id: 'all', label: t('All tenants'), href: '/', endContent: <Icon icon={ArrowRightIcon} size="sm" color="secondary" />},
  ];
  const label = name ?? '…';
  return (
    <span className="sp-crumb-wrap">
      {!here && (
        <Link className="sp-crumb" href={tenantHref('/tenant/', id)} title={name}>
          <span className="sp-crumb-name">{label}</span>
        </Link>
      )}
      <DropdownMenu
        isMenuOpen={open}
        onOpenChange={setOpen}
        menuWidth={280}
        menuMaxHeight={420}
        items={items}
        renderTrigger={props =>
          here ? (
            <button type="button" {...props} className="sp-crumb" aria-label={t('Switch {name}', {name: label})} title={t('Switch {name}', {name: label})}>
              <span className="sp-crumb-name">{label}</span>
              <span className="sp-chev" aria-hidden="true">
                <Icon icon={ChevronDownIcon} size="xsm" color="secondary" />
              </span>
            </button>
          ) : (
            <button type="button" {...props} className="sp-crumb sp-chev-only" aria-label={t('Switch {name}', {name: label})} title={t('Switch {name}', {name: label})}>
              <span className="sp-chev" aria-hidden="true">
                <Icon icon={ChevronDownIcon} size="xsm" color="secondary" />
              </span>
            </button>
          )
        }
      />
    </span>
  );
}

function Steps({state, current}: {state: ProjectState; current: NodeId | 'overview'}) {
  const st = stepStates(state);
  return (
    <span className="sp-steps" role="list" aria-label={t('Workflow')}>
      {NODES.map((n, i) => (
        <Fragment key={n.id}>
          {i > 0 && (
            <span className="sp-step-arrow" aria-hidden="true">
              <Icon icon={ArrowRightIcon} size="sm" color="secondary" />
            </span>
          )}
          <span role="listitem">
            <TopNavItem
              label={t(n.label)}
              href={hrefFor(state.project.id, n.path)}
              isSelected={current === n.id}
              icon={
                st[n.id] === 'done' ? <Icon icon={CheckCircleIcon} size="sm" color="success" label={t('Finished')} /> : st[n.id] === 'running' ? <Spinner size="sm" aria-label={t('Running')} /> : undefined
              }
            />
          </span>
        </Fragment>
      ))}
    </span>
  );
}

/** English or 中文 (spec 1.1.0, 2.2); the current one ticked. */
function LanguageMenu() {
  const {locale, setLocale} = useLocale();
  return (
    <DropdownMenu
      alignment="end"
      items={LOCALES.map(l => ({
        id: l.id,
        label: <span lang={l.id === 'zh' ? 'zh-CN' : 'en'}>{l.name}</span>,
        endContent: l.id === locale ? <Icon icon={CheckCircleIcon} size="sm" color="secondary" label={t('Current')} /> : undefined,
        onClick: () => l.id !== locale && setLocale(l.id),
      }))}
      renderTrigger={props => (
        <IconButton {...props} className="sp-lang" label={t('Language')} tooltip={t('Language: English / 中文')} variant="ghost" size="sm" icon={<Icon icon={LanguageIcon} size="sm" />} />
      )}
    />
  );
}

/**
 * The avatar: the user's name, the stand-in note while stand-ins run, and Sign out when the
 * platform can end the session (2026-11-16 refinements, 1.2).
 */
function AccountMenu() {
  const {info} = useRuntime();
  const name = info?.user.name ?? '';
  const standIns = info?.standIns ?? [];
  const items: DropdownMenuOption[] = [
    {id: 'name', label: name, description: info?.tenant ? `${info.tenant.name} · ${info.tenant.role === 'admin' ? t('Admin') : t('Member')}` : undefined, isDisabled: true},
    ...(standIns.length ? [{id: 'standins', label: t('Stand-in services'), description: standIns.map(x => t(x)).join(', '), isDisabled: true}] : []),
    ...(info?.canSignOut
      ? [
          {type: 'divider' as const},
          {
            id: 'out',
            label: t('Sign out'),
            icon: <Icon icon={ArrowRightStartOnRectangleIcon} size="sm" />,
            onClick: () => {
              void signOut().finally(() => window.location.reload());
            },
          },
        ]
      : []),
  ];
  return (
    <DropdownMenu
      alignment="end"
      menuWidth={240}
      items={items}
      renderTrigger={props => (
        <button type="button" {...props} className="sp-avatar" aria-label={name ? t('{name}: account', {name}) : t('Account')} title={name}>
          <Avatar name={name || '?'} size="sm" />
        </button>
      )}
    />
  );
}
