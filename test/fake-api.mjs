import { hashFiles } from '../lib/hash.mjs';
import { pack } from '../lib/tar.mjs';

export function fakeApi() {
  const skills = new Map();
  const tarballs = new Map();
  const versions = new Map();
  const api = {
    published: [],
    conflicts: new Set(),
    addSkill({ slug, files, kind = 'skill', plugin_slug = null, description = `${slug} skill` }) {
      const sha256 = files ? hashFiles(files) : null;
      skills.set(slug, { slug, name: slug, description, kind, plugin_slug, sha256, scan_flags: [] });
      if (files) tarballs.set(slug, { sha256, tarball: pack(files) });
      return sha256;
    },
    tamper(slug, files) { tarballs.get(slug).tarball = pack(files); },
    failDownload(slug, error) { tarballs.set(slug, { error }); },
    setVersions(slug, list) { versions.set(slug, list); },
    async getSkill(slug) { return skills.get(slug) ?? null; },
    async download(slug) {
      const t = tarballs.get(slug);
      if (!t) throw Object.assign(new Error(`not found: ${slug}`), { status: 404 });
      if (t.error) throw t.error;
      return { sha256: t.sha256, tarball: t.tarball };
    },
    async versions(slug) { return versions.get(slug) ?? []; },
    failPublish: null,
    async publish(manifest, tarball) {
      if (api.failPublish) throw api.failPublish;
      if (api.conflicts.has(manifest.slug)) throw Object.assign(new Error('conflict'), { status: 409, code: 'conflict' });
      api.published.push({ manifest, tarball });
      // Like the server: an approved publish becomes the current version returned by getSkill.
      if (manifest.status === 'approved') {
        skills.set(manifest.slug, { slug: manifest.slug, name: manifest.name, description: manifest.description, kind: manifest.kind, plugin_slug: manifest.plugin_slug ?? null, sha256: manifest.sha256, scan_flags: manifest.scan_flags ?? [] });
      }
      return { skillId: api.published.length, versionId: api.published.length };
    },
    async search() { return []; },
    async updates() { return []; },
    // Records install events; set failInstallEvent to make the call reject (the real one never does).
    events: [],
    failInstallEvent: null,
    async installEvent(event) {
      api.events.push(event);
      if (api.failInstallEvent) throw api.failInstallEvent;
    },
  };
  return api;
}
