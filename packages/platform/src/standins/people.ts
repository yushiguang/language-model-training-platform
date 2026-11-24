import type {PeopleDirectory, Person} from '@yushiguang/sprint-contracts';

/** A few made-up colleagues for the stand-in directory, so admins can try adding people. */
export const SAMPLE_PEOPLE: Person[] = [
  // The colleagues already in the default tenant (#107), then people who are in no tenant yet.
  {id: 'u-mei', name: 'Mei Wang', email: 'mei.wang@example.com'},
  {id: 'u-ravi', name: 'Ravi Kumar', email: 'ravi.kumar@example.com'},
  {id: 'u-ana', name: 'Ana Souza', email: 'ana.souza@example.com'},
  {id: 'u-tom', name: 'Tom Li', email: 'tom.li@example.com'},
  {id: 'u-ben', name: 'Ben Carter', email: 'ben.carter@example.com'},
  {id: 'u-chen', name: 'Chen Wei', email: 'chen.wei@example.com'},
  {id: 'u-dana', name: 'Dana Kim', email: 'dana.kim@example.com'},
  {id: 'u-omar', name: 'Omar Haddad', email: 'omar.haddad@example.com'},
];

/**
 * The stand-in company directory (#111): people whose name or email contains the query (no case),
 * names that start with it first. A deployment points `Platform.people` at its own directory.
 */
export function memoryPeople(people: Person[] = SAMPLE_PEOPLE): PeopleDirectory {
  return {
    async search(query, limit) {
      const q = query.trim().toLowerCase();
      if (!q) return [];
      const hits = people.filter(p => p.name.toLowerCase().includes(q) || (p.email ?? '').toLowerCase().includes(q));
      const starts = (p: Person) => Number(!p.name.toLowerCase().startsWith(q));
      return hits.sort((a, b) => starts(a) - starts(b) || a.name.localeCompare(b.name)).slice(0, Math.max(0, limit));
    },
  };
}
