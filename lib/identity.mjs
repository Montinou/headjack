// Request → owner id. A resolver turns a request into a subject ({ kind, refId, via }) or null; the first subject
// wins and app.resolve_owner maps it to owners.id. The app's resolver is Clerk (sessions, OAuth and API keys,
// lib/clerk-identity.mjs); the single-owner bearer token of v1 is retired.

// owners.ref_id of the initial owner: every v1 row belongs to it (drizzle/0002_multiuser.sql). The colon keeps it
// out of Better Auth's id alphabet, so it can never collide with a real user. It stays the initial owner's ref: maintenance
// scripts default to it and app.owner_aliases binds the first Clerk account to it.
export const LEGACY_OWNER_REF = 'legacy:v1';

// resolveOwner(kind, refId) → Promise<number> (lib/db.mjs). Owner ids never change, so they are cached per subject.
export function createIdentity({ resolvers, resolveOwner }) {
  const cache = new Map();
  return {
    // → Promise<{ ownerId: number, subject } | null>. null means 401.
    async identify(req) {
      for (const resolve of resolvers) {
        const subject = await resolve(req);
        if (!subject) continue;
        const key = `${subject.kind}\0${subject.refId}`;
        let ownerId = cache.get(key);
        if (ownerId === undefined) {
          ownerId = await resolveOwner(subject.kind, subject.refId);
          cache.set(key, ownerId);
        }
        return { ownerId, subject };
      }
      return null;
    },
  };
}
