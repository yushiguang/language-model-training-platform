'use client';

import Link from 'next/link';
import {useGo} from '@/components/nav';
import {useEffect, useState} from 'react';
import {NODES, nodeStatuses} from '@tsp/domain';
import type {Project} from '@tsp/contracts';
import {hrefFor} from '@/components/ProjectContext';
import {UserEnd} from '@/components/Shell';
import {createProject, listProjects, loadProjectState} from '@/backend-api';
import {Banner, Button, Card, dateTime, Field, Icon, PageHead, Table} from '@/ui';

/**
 * All projects (design: U-C-Projects, U-F-Projects-Loading, U-F-Projects-Error). The list shows as soon
 * as it arrives; each row's current step fills in as its project loads (R3-4).
 */
export default function Home() {
  const go = useGo();
  type Row = Project & {where?: string; path?: string};
  const [projects, setProjects] = useState<Row[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [name, setName] = useState('');

  const load = async () => {
    setFailed(null);
    setProjects(null);
    try {
      const list = await listProjects();
      setProjects(list);
      // The current step needs each project's state: fill rows in as they arrive.
      for (const p of list)
        void loadProjectState(p.id)
          .then(s => {
            const st = s ? nodeStatuses(s.facts) : null;
            // The first step not done yet; a project with every step done is Finished.
            const cur = st ? NODES.find(n => st[n.id] !== 'done') : NODES[0];
            const where = cur ? cur.label : 'Finished';
            const path = cur ? cur.path : '/training-set';
            setProjects(rows => rows?.map(r => (r.id === p.id ? {...r, where, path} : r)) ?? rows);
          })
          .catch(() => undefined);
    } catch (e) {
      setFailed(`Projects could not load: ${(e as Error).message || 'the service did not answer'}`);
    }
  };
  useEffect(() => {
    void load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async () => {
    const p = await createProject(name.trim() || 'Untitled project');
    await go(hrefFor(p.id, '/setup'));
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
                  cols={[{label: 'Project'}, {label: 'Current step'}, {label: 'Created'}]}
                  first={40}
                  rows={[180, 140, 200].map((w, i) => ({key: String(i), cells: [<span key="a" className="skel" style={{width: w}} />, <span key="b" className="skel" style={{width: 100}} />, <span key="c" className="skel" style={{width: 120}} />]}))}
                />
              </Card>
            ) : (
              projects.length > 0 && (
                <Card title="Projects" style={{width: 706}}>
                  <Table
                    cols={[{label: 'Project'}, {label: 'Current step'}, {label: 'Created'}]}
                    first={40}
                    rows={projects.map(p => ({
                      key: p.id,
                      cells: [
                        <Link key="n" className="one" href={hrefFor(p.id, p.path ?? '/setup')} title={p.name}>
                          {p.name}
                        </Link>,
                        p.where ?? <span key="w" className="skel" style={{width: 100}} />,
                        <span key="d" className="t-3">
                          {dateTime(p.createdAt)}
                        </span>,
                      ],
                    }))}
                  />
                </Card>
              )
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
