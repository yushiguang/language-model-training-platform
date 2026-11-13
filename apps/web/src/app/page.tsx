'use client';

import Link from 'next/link';
import {useGo} from '@/components/nav';
import {useEffect, useState} from 'react';
import type {Project} from '@tsp/contracts';
import {hrefFor} from '@/components/ProjectContext';
import {UserEnd} from '@/components/Shell';
import {createProject, deleteProject, listProjects} from '@/backend-api';
import {Banner, Button, Card, dateTime, Dialog, Field, Icon, PageHead, Table} from '@/ui';

/**
 * All projects (design: U-C-Projects, U-F-Projects-Loading, U-F-Projects-Error). One light call
 * lists them (spec 1.0.0, 2.4): a project opens on the step its own page works out. Delete asks
 * for the project's exact name first.
 */
export default function Home() {
  const go = useGo();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [doomed, setDoomed] = useState<Project | null>(null);
  const [typed, setTyped] = useState('');
  const [failed, setFailed] = useState<string | null>(null);
  const [name, setName] = useState('');

  const load = async () => {
    setFailed(null);
    setProjects(null);
    try {
      setProjects(await listProjects());
    } catch (e) {
      setFailed(`Projects could not load: ${(e as Error).message || 'the service did not answer'}`);
    }
  };
  useEffect(() => {
    void load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async () => {
    const p = await createProject(name.trim() || 'Untitled project');
    await go(hrefFor(p.id, '/prompt-design'));
  };

  const remove = async () => {
    if (!doomed || typed !== doomed.name) return;
    await deleteProject({projectId: doomed.id});
    setDoomed(null);
    setTyped('');
    await load();
  };

  return (
    <div className="k app b">
      <div className="b-body">
        <main className="b-main">
          <header className="topnav">
            <div className="island">
              <span className="proj">
                <span className="proj-ic" aria-hidden="true">
                  S
                </span>
                <b>Sprint</b>
              </span>
              <span />
              <UserEnd />
            </div>
          </header>
          <div className="b-head">
            <div className="container">
              <PageHead title="Projects" />
            </div>
          </div>
          <div className="container">
            <Card title="New project" style={{width: 706}} className="form" actions={<Button label="Create project" kind="primary" icon="plus" onClick={create} />}>
              <Field label="Project name">
                <input className="input" value={name} placeholder="Short-video tagging" onChange={e => setName(e.target.value)} />
              </Field>
            </Card>
            {failed ? (
              <Card title="Projects" style={{width: 706}}>
                <Banner tone="err" text={failed} style={{margin: 0}} action={<Button label="Retry" size="sm" onClick={load} />} />
              </Card>
            ) : !projects ? (
              <Card
                title="Projects"
                style={{width: 706}}
                titleExtra={
                  <span className="t-3 load-note" role="status">
                    <Icon name="ring" />
                    Loading projects
                  </span>
                }
              >
                <Table
                  cols={[{label: 'Project'}, {label: 'Created'}, {label: '', kind: 'act'}]}
                  actWidth={104}
                  first={40}
                  rows={[180, 140, 200].map((w, i) => ({key: String(i), cells: [<span key="a" className="skel" style={{width: w}} />, <span key="c" className="skel" style={{width: 120}} />, null]}))}
                />
              </Card>
            ) : (
              projects.length > 0 && (
                <Card title="Projects" style={{width: 706}}>
                  <Table
                    cols={[{label: 'Project'}, {label: 'Created'}, {label: '', kind: 'act'}]}
                  actWidth={104}
                    first={40}
                    rows={projects.map(p => ({
                      key: p.id,
                      cells: [
                        <Link key="n" className="one" href={hrefFor(p.id, '/prompt')} title={p.name}>
                          {p.name}
                        </Link>,
                        <span key="d" className="t-3">
                          {dateTime(p.createdAt)}
                        </span>,
                        <Button key="x" label="Delete" kind="ghost" size="sm" className="danger" ariaLabel={`Delete ${p.name}`} onClick={() => (setTyped(''), setDoomed(p))} />,
                      ],
                    }))}
                  />
                </Card>
              )
            )}
          </div>
          {doomed && (
            <Dialog
              title={`Delete ${doomed.name}?`}
              text="This permanently removes the project's dataset, gold labels, comments, prompt versions, scores, Optimiser history and chat messages. It cannot be undone."
              onClose={() => setDoomed(null)}
              actions={
                <>
                  <Button label="Delete project" kind="primary" className="danger" disabled={typed !== doomed.name} onClick={remove} />
                  <Button label="Cancel" onClick={() => setDoomed(null)} />
                </>
              }
            >
              <Field label={`Type the project name to confirm: ${doomed.name}`}>
                <input className="input" value={typed} aria-label="Project name" autoComplete="off" onChange={e => setTyped(e.target.value)} />
              </Field>
            </Dialog>
          )}
        </main>
      </div>
    </div>
  );
}
