-- Hand-written (drizzle-kit generate --custom): what Drizzle cannot express and 0002 needs to exist first.
DO $$
BEGIN
  IF NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'migrations must run as the owner role (superuser or BYPASSRLS), not as %', current_user;
  END IF;
END $$;--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS app;--> statement-breakpoint
-- The app role. NOLOGIN here; LOGIN + PASSWORD are set out of band per branch (scripts/set-app-password.mjs), so no
-- secret lives in git. Created with SQL on purpose: Neon gives roles made in its Console/API neon_superuser (BYPASSRLS).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'skillvault_app') THEN
    CREATE ROLE skillvault_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
  END IF;
END $$;--> statement-breakpoint
-- NULL unless app.owner_id holds an id: a pooled connection that ran set_config(..., true) earlier reads '' here,
-- and ''::bigint would raise instead of matching no row.
CREATE OR REPLACE FUNCTION app.current_owner_id() RETURNS bigint
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('app.owner_id', true), '')::bigint $$;
