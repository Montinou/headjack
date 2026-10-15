-- Hand-written (drizzle-kit generate --custom): FORCE RLS, owner resolution functions and the app role's grants.
-- 0001 leaves a pre-existing skillvault_app untouched; one made by hand with SUPERUSER or BYPASSRLS, or granted into a
-- role that has them (Neon Console roles are members of neon_superuser), would silently bypass every policy below, so
-- the whole migration stops here instead.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'skillvault_app' AND (rolsuper OR rolbypassrls))
     OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member = 'skillvault_app'::regrole) THEN
    RAISE EXCEPTION 'skillvault_app must not be superuser, bypassrls or a member of any role';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "owners" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skills" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "versions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sources" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chunks" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "upstream" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "blobs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Which owners have handed over a blob's bytes. The versions -> blobs foreign key is checked without RLS and the blobs
-- policy shows a blob to any owner with a version pointing at it, so without this a known hash (it is public: header,
-- listings) would be enough to read another owner's tarball. Written only by app.put_blob; the app role has no grant.
CREATE TABLE app.blob_holders (
  owner_id bigint NOT NULL REFERENCES public.owners (id),
  sha256 text NOT NULL REFERENCES public.blobs (sha256),
  PRIMARY KEY (owner_id, sha256)
);--> statement-breakpoint
INSERT INTO app.blob_holders (owner_id, sha256)
  SELECT DISTINCT v.owner_id, v.blob_sha256 FROM public.versions v WHERE v.blob_sha256 IS NOT NULL;--> statement-breakpoint
-- A version may point only at a blob its owner uploaded through app.put_blob (or already referenced before 0004).
CREATE OR REPLACE FUNCTION app.versions_blob_held() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.blob_sha256 IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM app.blob_holders h WHERE h.owner_id = NEW.owner_id AND h.sha256 = NEW.blob_sha256
  ) THEN
    RAISE EXCEPTION 'blob not uploaded by this owner' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app.versions_blob_held() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER versions_blob_held BEFORE INSERT OR UPDATE OF blob_sha256, owner_id ON public.versions
  FOR EACH ROW EXECUTE FUNCTION app.versions_blob_held();--> statement-breakpoint
-- Returns the owner id for (kind, ref_id), creating the row if missing. SECURITY DEFINER: runs as the migration
-- role (BYPASSRLS), so the app role needs no insert grant or policy on owners. Only the id leaves the function.
CREATE OR REPLACE FUNCTION app.resolve_owner(p_kind text, p_ref_id text) RETURNS bigint
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE found_id bigint;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('user', 'org') OR p_ref_id IS NULL OR length(p_ref_id) = 0 OR length(p_ref_id) > 200 THEN
    RAISE EXCEPTION 'invalid owner reference' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.owners (kind, ref_id) VALUES (p_kind, p_ref_id)
    ON CONFLICT (kind, ref_id) DO NOTHING RETURNING id INTO found_id;
  IF found_id IS NULL THEN
    SELECT o.id INTO found_id FROM public.owners o WHERE o.kind = p_kind AND o.ref_id = p_ref_id;
  END IF;
  RETURN found_id;
END $$;--> statement-breakpoint
-- Stores a tarball under the sha256 of its bytes (computed here, not by the caller) and returns that hash. Tarballs are
-- shared across owners, so the insert must not depend on who can already see the blob: an INSERT ... ON CONFLICT by
-- the app role would need the new row to pass the blobs SELECT policy, which only holds once a version references it.
-- Requires an owner in context, so nothing is stored outside an authenticated request, and records that owner as a
-- holder of the blob (app.blob_holders), which is what lets its versions point at it.
CREATE OR REPLACE FUNCTION app.put_blob(p_data bytea) RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE h text;
BEGIN
  IF app.current_owner_id() IS NULL THEN
    RAISE EXCEPTION 'put_blob needs app.owner_id' USING ERRCODE = '42501';
  END IF;
  IF p_data IS NULL THEN
    RAISE EXCEPTION 'blob data is required' USING ERRCODE = '22023';
  END IF;
  h := encode(sha256(p_data), 'hex');
  INSERT INTO public.blobs (sha256, data, size) VALUES (h, p_data, length(p_data)) ON CONFLICT (sha256) DO NOTHING;
  INSERT INTO app.blob_holders (owner_id, sha256) VALUES (app.current_owner_id(), h) ON CONFLICT DO NOTHING;
  RETURN h;
END $$;--> statement-breakpoint
-- Every owner id, for jobs that visit each owner in turn (the upstream cron). Ids only.
CREATE OR REPLACE FUNCTION app.list_owner_ids() RETURNS SETOF bigint
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$ SELECT o.id FROM public.owners o ORDER BY o.id $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app.resolve_owner(text, text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION app.list_owner_ids() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION app.put_blob(bytea) FROM PUBLIC;--> statement-breakpoint
GRANT USAGE ON SCHEMA app TO skillvault_app;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO skillvault_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.current_owner_id() TO skillvault_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.resolve_owner(text, text) TO skillvault_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.list_owner_ids() TO skillvault_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.put_blob(bytea) TO skillvault_app;--> statement-breakpoint
GRANT SELECT ON "owners" TO skillvault_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "skills" TO skillvault_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "versions" TO skillvault_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "sources" TO skillvault_app;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "chunks" TO skillvault_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "upstream" TO skillvault_app;--> statement-breakpoint
GRANT SELECT ON "blobs" TO skillvault_app;--> statement-breakpoint
GRANT USAGE ON SEQUENCE "skills_id_seq", "versions_id_seq", "sources_id_seq", "chunks_id_seq" TO skillvault_app;
