// Idempotent Clerk OAuth setup for one instance (spec D9, section 4.3).
//
//   node scripts/clerk-oauth-setup.mjs --env-file <dotenv outside the repo> [--dry-run]
//        [--delete-client <oauth client id>…] [--synthetic-users]
//
// The env file must hold CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: the issuer is derived from the
// publishable key, so the scope check and every write target the instance the secret key belongs to. A set
// HEADJACK_AUTH_SERVER_URL must equal that issuer, and sk_/pk_ must both be test or both live. Nothing is read from
// process.env. It enforces these instance settings: aud_claim_enabled, opaque access tokens (oauth_jwt_access_tokens off), no
// dynamic client registration, no client ID metadata documents advertised, only pre-registered metadata-document clients,
// and previously auto-connected metadata-document clients blocked. The script reads before it writes and prints only the
// instance issuer (test or live), names, ids, scopes, redirect URIs and settings: never a key or a client secret.
//
// Backend API (https://api.clerk.com/v1, Authorization: Bearer <secret>, Clerk-API-Version pinned), confirmed against the Clerk OpenAPI spec
// bapi/2026-05-12.yml (operations ListOAuthApplications, CreateOAuthApplication, UpdateOAuthApplication,
// DeleteOAuthApplication, Get/UpdateInstanceOAuthApplicationSettings, GetUserList, CreateUser). The installed
// @clerk/backend 3.23.0 has no wrapper for the settings endpoint and omits pkce_required, consent_screen_enabled and
// device_authorization_grant_enabled from its create/update types, so the script calls the REST API directly.
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const API_BASE = 'https://api.clerk.com/v1';
// The Backend API version the field names below were confirmed against; sent on every Backend API call.
export const API_VERSION = '2026-05-12';
const REQUEST_TIMEOUT_MS = 15_000;
const PAGE_SIZE = 100;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const CUSTOM_SCOPES = ['skills:read', 'skills:write'];
// Instance OAuth settings (spec D9): audience claim on, opaque tokens, and no dynamic or metadata-document client path.
// Pre-registered-only rejects only NEW unknown metadata-document clients; one that already auto-connected stays admitted
// unless the block-implicitly-allowed setting is on, so both are enforced (Backend API 2026-05-12).
export const SETTINGS = {
  aud_claim_enabled: true,
  oauth_jwt_access_tokens: false,
  dynamic_oauth_client_registration: false,
  client_id_metadata_documents_advertised: false,
  client_id_metadata_documents_only_allow_pre_registered_clients: true,
  client_id_metadata_documents_block_implicitly_allowed_clients: true,
};
// Public PKCE clients with a consent screen. The device grant is never enabled.
const CLIENT_BASE = {
  public: true,
  pkce_required: true,
  consent_screen_enabled: true,
  device_authorization_grant_enabled: false,
};
export const CLIENTS = [
  {
    name: 'headjack-mcp',
    ...CLIENT_BASE,
    scopes: 'skills:read offline_access',
    redirect_uris: ['http://localhost:53436/callback'],
  },
  {
    name: 'headjack-cli',
    ...CLIENT_BASE,
    scopes: 'openid email offline_access skills:read skills:write',
    redirect_uris: [53437, 53438, 53439].map((port) => `http://127.0.0.1:${port}/callback`),
  },
];
export const SYNTHETIC_EMAILS = [
  'headjack-acceptance-a+clerk_test@example.com',
  'headjack-acceptance-b+clerk_test@example.com',
];

const MANAGED_NAMES = CLIENTS.map((client) => client.name);

// A refused input or state: nothing was written. The CLI exits 2.
export class RefusedError extends Error {}

const words = (value) => new Set(String(value ?? '').split(/\s+/).filter(Boolean));
const sameSet = (a, b) => a.size === b.size && [...a].every((item) => b.has(item));

function ownerScopeStep(missing) {
  return [
    `Create the custom OAuth scope${missing.length > 1 ? 's' : ''} ${missing.join(' and ')} in this instance's Clerk Dashboard`,
    '(OAuth scopes catalog, key exactly as written, advertised in the authorization server metadata), then run this script again.',
    'The Backend API has no scope-catalog endpoint, so this step cannot be automated.',
  ].join(' ');
}

// current = { scopesSupported, settings, applications, syntheticUsers?, existingEmails? } -> Action[].
// A missing custom scope yields only an owner-step action: nothing may be written before the owner creates it.
export function planClerkSetup(current) {
  const advertised = new Set(current.scopesSupported ?? []);
  const missing = CUSTOM_SCOPES.filter((scope) => !advertised.has(scope));
  if (missing.length) return [{ type: 'owner-step', missing, text: ownerScopeStep(missing) }];

  const duplicates = MANAGED_NAMES.map((name) => ({ name, matches: (current.applications ?? []).filter((app) => app.name === name) }))
    .filter(({ matches }) => matches.length > 1);
  if (duplicates.length) {
    return duplicates.map(({ name, matches }) => ({
      type: 'owner-step',
      duplicate: name,
      text: `Warning: ${matches.length} applications are named ${name} (${matches.map((app) => `${app.id} client_id ${app.client_id}`).join('; ')}). `
        + 'Delete or rename the extras in the Clerk Dashboard so exactly one remains, then run this script again. Nothing was changed.',
    }));
  }

  const actions = [];
  const settings = current.settings ?? {};
  const settingsDiff = Object.fromEntries(Object.entries(SETTINGS).filter(([key, value]) => settings[key] !== value));
  if (Object.keys(settingsDiff).length) actions.push({ type: 'update-settings', body: settingsDiff });

  for (const desired of CLIENTS) {
    const app = (current.applications ?? []).find((candidate) => candidate.name === desired.name);
    if (!app) {
      actions.push({ type: 'create-client', name: desired.name, body: { ...desired, redirect_uris: [...desired.redirect_uris] } });
      continue;
    }
    const body = {};
    if (app.public !== desired.public) body.public = desired.public;
    if (app.pkce_required !== desired.pkce_required) body.pkce_required = desired.pkce_required;
    if (app.consent_screen_enabled !== desired.consent_screen_enabled) body.consent_screen_enabled = desired.consent_screen_enabled;
    if (!sameSet(words(app.scopes), words(desired.scopes))) body.scopes = desired.scopes;
    if (!sameSet(new Set(app.redirect_uris ?? []), new Set(desired.redirect_uris))) body.redirect_uris = [...desired.redirect_uris];
    if (app.device_authorization_grant_enabled === true) body.device_authorization_grant_enabled = false;
    if (Object.keys(body).length) actions.push({ type: 'update-client', name: desired.name, id: app.id, body });
  }

  if (current.syntheticUsers) {
    const present = new Set(current.existingEmails ?? []);
    for (const email of SYNTHETIC_EMAILS) if (!present.has(email)) actions.push({ type: 'create-user', email });
  }
  return actions;
}

function parsePublishableKey(key) {
  const match = /^pk_(test|live)_([A-Za-z0-9+/_=-]+)$/.exec(String(key ?? '').trim());
  const host = match ? Buffer.from(match[2], 'base64').toString('utf8').replace(/\$$/, '') : '';
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) throw new RefusedError('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is not a Clerk publishable key');
  return { issuer: `https://${host}`, mode: match[1] };
}

export function issuerFromPublishableKey(key) {
  return parsePublishableKey(key).issuer;
}

const secretKeyMode = (secretKey) => /^sk_(test|live)_/.exec(String(secretKey ?? ''))?.[1];
const normalizeIssuer = (value) => String(value).trim().replace(/\/+$/, '').toLowerCase();

// The one instance the run targets: the issuer comes from the publishable key (same instance as the secret key).
// Refuses a test/live mismatch and an HEADJACK_AUTH_SERVER_URL that names another instance.
export function resolveInstance(env) {
  const mode = secretKeyMode(env.CLERK_SECRET_KEY);
  if (!mode) throw new RefusedError('CLERK_SECRET_KEY is not a Clerk secret key (expected the sk_test_ or sk_live_ prefix)');
  if (!env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) throw new RefusedError('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is missing from the env file: the instance issuer is derived from it');
  const publishable = parsePublishableKey(env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
  if (publishable.mode !== mode) {
    throw new RefusedError(`CLERK_SECRET_KEY is a ${mode} key but NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is a ${publishable.mode} key: they must belong to the same instance`);
  }
  if (env.HEADJACK_AUTH_SERVER_URL && normalizeIssuer(env.HEADJACK_AUTH_SERVER_URL) !== normalizeIssuer(publishable.issuer)) {
    throw new RefusedError(`HEADJACK_AUTH_SERVER_URL (${env.HEADJACK_AUTH_SERVER_URL}) differs from the issuer of the publishable key (${publishable.issuer}): refusing to read scopes from one instance and write to another`);
  }
  return { issuer: publishable.issuer, mode };
}

// A real path, even when the file does not exist yet: resolve the nearest existing ancestor and re-append the rest.
async function resolveReal(target) {
  const absolute = path.resolve(target);
  const rest = [];
  let probe = absolute;
  for (;;) {
    try {
      return path.join(await realpath(probe), ...rest);
    } catch (error) {
      const parent = path.dirname(probe);
      if (error.code !== 'ENOENT' || parent === probe) throw error;
      rest.unshift(path.basename(probe));
      probe = parent;
    }
  }
}

async function hasGitEntry(directory) {
  try {
    await lstat(path.join(directory, '.git'));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

// Refuses the repository root and anything under it, and any file under a directory that holds a .git entry (a file for a
// worktree, a directory for a checkout), so no checkout or worktree of any repository can hold the env file.
export async function assertOutsideRepo(file, repoRoot = REPO_ROOT) {
  const [real, root] = await Promise.all([resolveReal(file), resolveReal(repoRoot)]);
  const relative = path.relative(root, real);
  const outside = relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  if (!outside) {
    throw new RefusedError('the env file is inside the repository: keep it outside (for example under ~/.config) so it cannot be committed');
  }
  for (let directory = path.dirname(real); ; directory = path.dirname(directory)) {
    if (await hasGitEntry(directory)) {
      throw new RefusedError(`the env file is inside a git checkout (${directory} has a .git entry): keep it outside every checkout and worktree (for example under ~/.config)`);
    }
    if (path.dirname(directory) === directory) return;
  }
}

function parseEnv(text) {
  const env = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    env[match[1]] = value;
  }
  return env;
}

// Reads the dotenv file only (never process.env) and refuses a file inside the repository.
export async function loadEnvFile(file, repoRoot = REPO_ROOT) {
  await assertOutsideRepo(file, repoRoot);
  const env = parseEnv(await readFile(file, 'utf8'));
  if (!env.CLERK_SECRET_KEY) throw new Error('CLERK_SECRET_KEY is missing from the env file');
  return env;
}

class ClerkApiError extends Error {}

function createClient({ secretKey, fetchImpl }) {
  const redact = (text) => String(text).split(secretKey).join('[redacted]');
  // backend = false is the public issuer metadata request: no credential and no Backend API version header.
  async function call(url, { method = 'GET', body, backend = true } = {}) {
    const headers = { Accept: 'application/json' };
    if (backend) {
      headers.Authorization = `Bearer ${secretKey}`;
      headers['Clerk-API-Version'] = API_VERSION;
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new ClerkApiError(redact(`${method} ${new URL(url).pathname} failed: ${error.message}`));
    }
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : undefined; } catch { data = undefined; }
    if (!response.ok) {
      const code = Array.isArray(data?.errors) && typeof data.errors[0]?.code === 'string' ? ` ${data.errors[0].code}` : '';
      throw new ClerkApiError(redact(`${method} ${new URL(url).pathname} -> ${response.status}${code}`));
    }
    return data;
  }
  const api = (method, route, body) => call(`${API_BASE}${route}`, { method, body });
  async function listApplications(nameQuery) {
    const collected = [];
    for (;;) {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(collected.length) });
      if (nameQuery) params.set('name_query', nameQuery);
      const page = await api('GET', `/oauth_applications?${params}`);
      const data = Array.isArray(page?.data) ? page.data : [];
      collected.push(...data);
      if (!data.length || collected.length >= (page.total_count ?? collected.length)) return collected;
    }
  }
  return { call, api, listApplications };
}

const publicClient = (app) => ({
  name: app.name,
  id: app.id,
  clientId: app.client_id,
  public: app.public,
  pkceRequired: app.pkce_required,
  consentScreen: app.consent_screen_enabled,
  deviceGrant: typeof app.device_authorization_grant_enabled === 'boolean' ? app.device_authorization_grant_enabled : 'unknown',
  scopes: app.scopes,
  redirectUris: app.redirect_uris,
});

// Reads the issuer metadata, the settings, the applications (and users); plans; then writes unless dryRun or blocked.
export async function applyClerkSetup({ secretKey, issuer, fetchImpl = fetch, dryRun = false, deleteClientIds = [], syntheticUsers = false }) {
  if (!secretKey) throw new Error('CLERK_SECRET_KEY is required');
  if (!issuer) throw new Error('the instance issuer URL is required');
  if (syntheticUsers && secretKey.startsWith('sk_live_')) {
    throw new RefusedError('--synthetic-users is for a development instance only: refusing a production (sk_live_) key');
  }
  const { call, api, listApplications } = createClient({ secretKey, fetchImpl });

  const normalizedIssuer = issuer.replace(/\/+$/, '');
  const metadata = await call(`${normalizedIssuer}/.well-known/oauth-authorization-server`, { backend: false });
  const settings = await api('GET', '/instance/oauth_application_settings');
  const applications = await listApplications();
  const existingEmails = [];
  if (syntheticUsers) {
    for (const email of SYNTHETIC_EMAILS) {
      const found = await api('GET', `/users?${new URLSearchParams({ email_address: email })}`);
      if (Array.isArray(found) && found.length) existingEmails.push(email);
    }
  }

  const plan = planClerkSetup({ scopesSupported: metadata?.scopes_supported ?? [], settings, applications, syntheticUsers, existingEmails });
  const ownerSteps = plan.filter((action) => action.type === 'owner-step');
  const report = {
    instance: { issuer: normalizedIssuer, mode: secretKey.startsWith('sk_live_') ? 'live' : secretKey.startsWith('sk_test_') ? 'test' : 'unknown' },
    dryRun,
    blocked: ownerSteps.length > 0,
    ownerSteps: ownerSteps.map((step) => step.text),
    actions: [],
    notFound: [],
    settings: { ...settings },
    clients: [],
  };
  delete report.settings.object;
  if (report.blocked) return report;

  // Deletion targets are resolved by exact OAuth client id (the list filter also matches names, so it is re-checked).
  const deletions = [];
  for (const clientId of deleteClientIds) {
    const target = (await listApplications(clientId)).find((app) => app.client_id === clientId);
    if (!target) report.notFound.push(clientId);
    else if (MANAGED_NAMES.includes(target.name)) {
      throw new RefusedError(`--delete-client ${clientId} is the managed client ${target.name} (${target.id}): this script creates and reconciles it, never deletes it`);
    } else deletions.push({ type: 'delete-client', clientId, id: target.id, name: target.name });
  }

  const byName = new Map(applications.map((app) => [app.name, app]));
  try {
    for (const action of plan) {
      const summary = { ...action };
      if (action.type === 'update-settings') {
        if (!dryRun) Object.assign(report.settings, pickSettings(await api('PATCH', '/instance/oauth_application_settings', action.body)));
        else Object.assign(report.settings, action.body);
      } else if (action.type === 'create-client') {
        if (!dryRun) byName.set(action.name, await api('POST', '/oauth_applications', action.body));
        else byName.set(action.name, { ...action.body, id: undefined, client_id: undefined });
      } else if (action.type === 'update-client') {
        if (!dryRun) byName.set(action.name, await api('PATCH', `/oauth_applications/${encodeURIComponent(action.id)}`, action.body));
        else byName.set(action.name, { ...byName.get(action.name), ...action.body });
      } else if (action.type === 'create-user') {
        if (!dryRun) await api('POST', '/users', { email_address: [action.email], skip_password_requirement: true });
      }
      report.actions.push(summary);
    }
    for (const deletion of deletions) {
      if (!dryRun) await api('DELETE', `/oauth_applications/${encodeURIComponent(deletion.id)}`);
      report.actions.push(deletion);
    }
  } catch (error) {
    error.applied = [...report.actions];
    throw error;
  }
  report.clients = CLIENTS.map((desired) => byName.get(desired.name)).filter(Boolean).map(publicClient);
  return report;
}

function pickSettings(settings) {
  return Object.fromEntries(Object.keys(SETTINGS).map((key) => [key, settings?.[key]]));
}

function describeAction(action) {
  switch (action.type) {
    case 'update-settings': return `settings: set ${Object.entries(action.body).map(([k, v]) => `${k}=${v}`).join(', ')}`;
    case 'create-client': return `client ${action.name}: create`;
    case 'update-client': return `client ${action.name} (${action.id}): update ${Object.keys(action.body).join(', ')}`;
    case 'create-user': return `user ${action.email}: create`;
    case 'delete-client': return `client ${action.name} (${action.id}, client_id ${action.clientId}): delete`;
    default: return action.type;
  }
}

export function formatReport(report) {
  const lines = [];
  if (report.instance) lines.push(`Instance: ${report.instance.issuer} (${report.instance.mode})`);
  if (report.dryRun) lines.push('Dry run: nothing was written.');
  if (report.blocked) {
    lines.push('Owner step required before any change can be made:');
    for (const text of report.ownerSteps) lines.push(`  ${text}`);
    return lines;
  }
  lines.push(report.actions.length ? `${report.dryRun ? 'Planned' : 'Applied'} changes:` : 'No changes needed: the instance already matches.');
  for (const action of report.actions) lines.push(`  ${describeAction(action)}`);
  for (const clientId of report.notFound) lines.push(`  client_id ${clientId}: not found, nothing deleted`);
  lines.push('Settings:');
  for (const [key, value] of Object.entries(report.settings)) lines.push(`  ${key}=${value}`);
  lines.push('Clients:');
  for (const client of report.clients) {
    lines.push(`  ${client.name}: id=${client.id ?? '(created on apply)'} client_id=${client.clientId ?? '(created on apply)'}`);
    lines.push(`    public=${client.public} pkce_required=${client.pkceRequired} consent_screen=${client.consentScreen} device_grant=${client.deviceGrant}`);
    lines.push(`    scopes: ${client.scopes}`);
    lines.push(`    redirect URIs: ${(client.redirectUris ?? []).join(' ')}`);
  }
  return lines;
}

function parseArgs(argv) {
  const options = { envFile: undefined, dryRun: false, syntheticUsers: false, deleteClientIds: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--synthetic-users') options.syntheticUsers = true;
    else if (arg === '--env-file') {
      options.envFile = argv[i + 1];
      i += 1;
      if (!options.envFile || options.envFile.startsWith('--')) throw new Error('--env-file needs a path');
    } else if (arg === '--delete-client') {
      const before = options.deleteClientIds.length;
      while (argv[i + 1] && !argv[i + 1].startsWith('--')) { options.deleteClientIds.push(argv[i + 1]); i += 1; }
      if (options.deleteClientIds.length === before) throw new Error('--delete-client needs at least one OAuth client id');
    } else throw new Error(`unknown argument ${arg}`);
  }
  if (!options.envFile) throw new Error('usage: clerk-oauth-setup.mjs --env-file <path outside the repo> [--dry-run] [--delete-client <id>…] [--synthetic-users]');
  return options;
}

// Exit codes: 0 done, 1 blocked on an owner step or API failure, 2 usage or refused input (nothing was written).
export async function main(argv, { fetchImpl = fetch, log = console.log, error = console.error } = {}) {
  let options;
  let env;
  try {
    options = parseArgs(argv);
    env = await loadEnvFile(options.envFile);
    resolveInstance(env);
  } catch (e) {
    error(e.message);
    return 2;
  }
  let report;
  try {
    const { issuer } = resolveInstance(env);
    report = await applyClerkSetup({
      secretKey: env.CLERK_SECRET_KEY,
      issuer,
      fetchImpl,
      dryRun: options.dryRun,
      deleteClientIds: options.deleteClientIds,
      syntheticUsers: options.syntheticUsers,
    });
  } catch (e) {
    error(String(e.message).split(env.CLERK_SECRET_KEY).join('[redacted]'));
    if (e.applied?.length) {
      error('Applied before the failure:');
      for (const action of e.applied) error(`  ${describeAction(action)}`);
    }
    return e instanceof RefusedError ? 2 : 1;
  }
  for (const line of formatReport(report)) log(line);
  return report.blocked ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
