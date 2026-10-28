/** An artifact's version as a tag beside its title, never part of the title. */
export function VersionTag({version}: {version?: string}) {
  if (!version) return null;
  return <span className="version-tag">{version.toUpperCase()}</span>;
}
