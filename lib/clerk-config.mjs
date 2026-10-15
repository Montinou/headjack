// UI/provider and proxy availability only. API identity/scopes/RLS remain authoritative.
export function clerkConfigured(env) {
  return Boolean(
    env.CLERK_SECRET_KEY?.trim() &&
    env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim(),
  );
}
