'use client';

import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {useEffect, useState} from 'react';
import {NODES, nodeStatuses} from '@tsp/domain';
import type {Project} from '@tsp/contracts';
import {hrefFor} from '@/components/ProjectContext';
import {UserEnd} from '@/components/Shell';
import {createProject, listProjects, loadProjectState} from '@/backend-api';
import {Button, Card, dateTime, Field, PageHead, Table} from '@/ui';

/**
 * All projects. Not drawn on the Unified UI canvas (see docs/ui-gaps.md): built from the same
 * shell and parts, without the step bar.
 */
export default function Home() {
  const router = useRouter();
  const [projects, setProjects] = useState<(Project & {where: string; path: string})[] | null>(null);
  const [name, setName] = useState('');

  useEffect(() => {
    void (async () => {
      const list = await listProjects();
      const withWhere = await Promise.all(
        list.map(async p => {
          const s = await loadProjectState(p.id);
          const st = s ? nodeStatuses(s.facts) : null;
          // The first step not done yet; a project with every step done is Finished.
          const cur = st ? NODES.find(n => st[n.id] !== 'done') : NODES[0];
          return {...p, where: cur ? cur.label : 'Finished', path: cur ? cur.path : '/training-set'};
        }),
      );
      setProjects(withWhere);
    })();
  }, []);

  const create = async () => {
    const p = await createProject(name.trim() || 'Untitled project');
    router.push(hrefFor(p.id, '/setup'));
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
            {projects && projects.length > 0 && (
              <Card title="Projects" style={{width: 706}}>
                <Table
                  cols={[{label: 'Project'}, {label: 'Current step'}, {label: 'Created'}]}
                  first={40}
                  rows={projects.map(p => ({
                    key: p.id,
                    cells: [
                      <Link key="n" className="one" href={hrefFor(p.id, p.path)} title={p.name}>
                        {p.name}
                      </Link>,
                      p.where,
                      <span key="d" className="t-3">
                        {dateTime(p.createdAt)}
                      </span>,
                    ],
                  }))}
                />
              </Card>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
