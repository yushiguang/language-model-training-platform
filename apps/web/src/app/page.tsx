'use client';

import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {useEffect, useState} from 'react';
import {NODES, nodeStatuses} from '@/core/gates';
import type {Project} from '@/core/types';
import {hrefFor} from '@/components/ProjectContext';
import {createProject, listProjects, loadProjectState} from '@/backend-api';
import {Button, timeOf} from '@/ui';

/** All projects. A project is one model's training set, from setup to the finished set. */
export default function Home() {
  const router = useRouter();
  const [projects, setProjects] = useState<(Project & {where: string; path: string})[] | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const list = await listProjects();
      const withWhere = await Promise.all(
        list.map(async p => {
          const s = await loadProjectState(p.id);
          const st = s ? nodeStatuses(s.facts) : null;
          const cur = NODES.find(n => st?.[n.id] === 'current');
          return {...p, where: cur ? cur.label : 'Finished', path: cur ? cur.path : '/training-set'};
        }),
      );
      setProjects(withWhere);
    })();
  }, []);

  const create = async () => {
    setBusy(true);
    const p = await createProject(name.trim() || 'Untitled project');
    router.push(hrefFor(p.id, '/setup'));
  };

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">
          <span className="brand-mark" aria-hidden="true">
            TS
          </span>
          <span style={{fontWeight: 600}}>Training Set Platform</span>
        </span>
      </header>
      <div className="body">
        <main className="main">
          <div className="page">
            <div className="page-head">
              <h1>Projects</h1>
              <p className="muted">Each project makes one training set: agree on the labels, add examples, improve the prompt, then generate.</p>
            </div>
            <div className="card">
              <h2>New project</h2>
              <div className="row">
                <label className="sr-only" htmlFor="name">
                  Project name
                </label>
                <input id="name" className="text-input grow" placeholder="For example: Short-video tagging" value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && void create()} />
                <Button label="Create project" variant="primary" size="lg" onClick={create} loading={busy} />
              </div>
            </div>
            {projects && projects.length > 0 && (
              <div className="card tight">
                <table className="t">
                  <thead>
                    <tr>
                      <th>Project</th>
                      <th>Current step</th>
                      <th>Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {projects.map(p => (
                      <tr key={p.id}>
                        <td>
                          <Link href={hrefFor(p.id, p.path)}>{p.name}</Link>
                        </td>
                        <td>{p.where}</td>
                        <td className="muted">{timeOf(p.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
