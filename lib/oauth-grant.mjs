// Online verification of Clerk opaque OAuth access tokens and live user admission, shared by the REST resolver and the MCP.
// Neither result is cached: revocation, a ban or a lock closes access on the next request.

const USER_ID = /^user_[A-Za-z0-9]+$/;
const UNAVAILABLE = 'identity service unavailable';

// RFC 9110: only the scheme is case-insensitive; its separator is one or more SP.
export const OAT_BEARER = /^[Bb][Ee][Aa][Rr][Ee][Rr] +(oat_[A-Za-z0-9_-]+)$/;

// The token must be bound to `resource` (its audience), unrevoked and unexpired, and belong to a user. SDK rejections of
// the token itself (401, 404, failed verification) deny; anything else is an outage, reported without SDK detail.
export async function verifyResourceGrant(client, { token, resource }) {
  let verified;
  try {
    verified = await client.idPOAuthAccessToken.verify(token, { audience: resource });
  } catch (e) {
    if (e?.status === 401 || e?.status === 404 || e?.reason === 'token-verification-failed') return null;
    throw new Error(UNAVAILABLE);
  }
  if (!verified || !Array.isArray(verified.aud) || !verified.aud.includes(resource)
    || verified.revoked !== false || verified.expired !== false
    || typeof verified.subject !== 'string' || !USER_ID.test(verified.subject)
    || !Array.isArray(verified.scopes) || !verified.scopes.every((scope) => typeof scope === 'string')) return null;
  return { userId: verified.subject, scopes: [...verified.scopes] };
}

// The live Clerk user behind a verified credential, as the owner reference `clerk:<id>`, or null when the account is gone,
// mismatched, banned, locked or has no verified primary email.
export async function admitClerkUser(client, userId) {
  try {
    const user = await client.users.getUser(userId);
    if (!user || user.id !== userId || user.banned || user.locked) return null;
    const primary = user.emailAddresses?.find((email) => email.id === user.primaryEmailAddressId);
    if (primary?.verification?.status !== 'verified') return null;
    return `clerk:${user.id}`;
  } catch (e) {
    if (e?.status === 404) return null;
    // SDK failures may contain credentials or profile data. Expose no original message, object or cause.
    throw new Error(UNAVAILABLE);
  }
}
