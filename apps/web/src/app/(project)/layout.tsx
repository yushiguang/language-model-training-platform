import {ProjectShell} from '@/components/Shell';

/**
 * Every step page shares one shell: the project state, the top island and the Ask AI open state
 * stay mounted while the user moves between steps, so a step change never blanks the page.
 */
export default function ProjectLayout({children}: {children: React.ReactNode}) {
  return <ProjectShell>{children}</ProjectShell>;
}
