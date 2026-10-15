// Base URL for metadata that needs absolute URLs (Open Graph and Twitter images). Mirrors Next.js's own fallback: the
// production URL Vercel provides, otherwise localhost on the server's port. Setting it explicitly keeps self-hosted and
// local builds free of the "metadataBase is not set" warning; Vercel previews still use their preview URL.
export function siteUrl(env) {
  if (env.VERCEL_PROJECT_PRODUCTION_URL) return new URL(`https://${env.VERCEL_PROJECT_PRODUCTION_URL}`);
  return new URL(`http://localhost:${env.PORT || 3000}`);
}
