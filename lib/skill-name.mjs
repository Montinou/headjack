// The Skill tool's name -> the vault slug it denotes (spec §5.2). Pure; no npm dependencies.
//
// Vault slugs are `<slug>` or `<plugin>@<marketplace>:<skill>`; the Skill tool reports `<skill>` or `<plugin>:<skill>`.
//   - no ":"                    -> the vault slug equal to it
//   - `<plugin>:<skill>`        -> the vault slugs `<plugin>@*:<skill>`; with several marketplaces the one enabled in
//                                  `enabledPlugins` wins; still ambiguous -> null
//   - a prefix containing "/"   -> only the part after the last ":" is mapped (`apps/web:deploy` -> `deploy`)
//   - not in the vault          -> null
// `slugs` is a Set of vault slugs, `enabledPlugins` the `enabledPlugins` object of ~/.claude/settings.json.
export function toVaultSlug(name, { slugs, enabledPlugins = {} }) {
  if (typeof name !== 'string') return null;
  const colon = name.lastIndexOf(':');
  if (colon === -1) return name !== '' && slugs.has(name) ? name : null;
  const plugin = name.slice(0, colon);
  const skill = name.slice(colon + 1);
  if (!plugin || !skill) return null;
  if (plugin.includes('/')) return slugs.has(skill) ? skill : null;

  const head = `${plugin}@`;
  const tail = `:${skill}`;
  const candidates = [...slugs].filter((slug) => {
    if (!slug.startsWith(head) || !slug.endsWith(tail) || slug.length <= head.length + tail.length) return false;
    // The marketplace is whatever sits between "@" and the final ":<skill>"; it never contains ":".
    return !slug.slice(head.length, slug.length - tail.length).includes(':');
  });
  if (candidates.length <= 1) return candidates[0] ?? null;
  const enabled = candidates.filter((slug) => enabledPlugins[slug.slice(0, slug.length - tail.length)] === true);
  return enabled.length === 1 ? enabled[0] : null;
}
