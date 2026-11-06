'use client';

import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {useEffect, useState} from 'react';
import {NODES, nodeStatuses} from '@tsp/domain';
import type {Project} from '@tsp/contracts';
import {hrefFor} from '@/components/ProjectContext';
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
          const cur = NODES.find(n => st?.[n.id] === 'current');
          return {...p, where: cur ? cur.label : 'Training Set', path: cur ? cur.path : '/training-set'};
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
      <header className="topnav">
        <span className="brand">
          <span className="brand-mark" aria-hidden="true">
            TS
          </span>
          <span className="brand-t">
            <b>Training Set Platform</b>
          </span>
        </span>
      </header>
      <div className="b-body">
        <main className="b-main">
          <div className="b-head">
            <div className="container">
              <PageHead title="Projects" />
            </div>
          </div>
          <div className="container">
            <Card title="New project" style={{width: 706}} className="form" actions={<Button label="Create project" kind="primary" icon="plus" onClick={create} />}>
              <Field label="Project name">
                <input className="input" value={name} placeholder="Short-video tagging" onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && void create()} />
              </Field>
            </Card>
            {projects && projects.length > 0 && (
              <Card title="Projects">
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
