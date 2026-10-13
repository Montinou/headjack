// Upstream update checks for local mode. The hosted cron handler (needs CRON_SECRET, owners and event pruning) is not
// reused: this takes the vault's targets, skips what cannot or need not be checked, and records the rest.
import { checkUpstream } from '../upstream.mjs';
import { isBusy } from './schema.mjs';

export const DEFAULT_TTL_HOURS = 6;
const HOUR_MS = 3_600_000;

// HEADJACK_UPDATE_TTL_HOURS as a number of hours: unset, empty, negative or not a number falls back to the default.
export function ttlHoursFrom(value) {
  if (value == null || String(value).trim() === '') return DEFAULT_TTL_HOURS;
  const hours = Number(value);
  return Number.isFinite(hours) && hours >= 0 ? hours : DEFAULT_TTL_HOURS;
}

// A failure on one target (offline, rate limit, a vanished path) is counted and never thrown, except a busy vault: the
// answer could not be recorded, so reporting "up to date" would be wrong and the caller must see it.
export async function checkLocalUpdates({ repo, fetchImpl, githubToken, ttlHours = DEFAULT_TTL_HOURS, now = Date.now }) {
  const cache = new Map();
  const result = { checked: 0, skipped: 0, failed: 0 };
  const ttlMs = ttlHours * HOUR_MS;
  const at = now();
  for (const target of await repo.listUpstreamTargets()) {
    // Imported skills have no commit to compare against; a recent check (checked_at is an ISO string) is still fresh.
    const checkedAt = target.checked_at ? Date.parse(target.checked_at) : NaN;
    if (target.commit_sha == null || (Number.isFinite(checkedAt) && at - checkedAt < ttlMs)) {
      result.skipped++;
      continue;
    }
    try {
      const { latest, updateAvailable } = await checkUpstream(target, fetchImpl, githubToken, cache);
      await repo.markUpstream(target.skill_id, latest, updateAvailable);
      result.checked++;
    } catch (e) {
      if (isBusy(e)) throw e;
      result.failed++;
    }
  }
  return result;
}
