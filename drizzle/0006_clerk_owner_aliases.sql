-- Operator-only bindings preserve the original owner id and every dependent row.
-- No application role can read or mutate this table, or claim the legacy owner.
CREATE TABLE app.owner_aliases (
  kind text NOT NULL CHECK (kind = 'user'),
  ref_id text NOT NULL CHECK (ref_id ~ '^clerk:user_[A-Za-z0-9]+$'),
  owner_id bigint NOT NULL UNIQUE REFERENCES public.owners(id),
  PRIMARY KEY (kind, ref_id)
);--> statement-breakpoint
REVOKE ALL ON app.owner_aliases FROM PUBLIC, skillvault_app;--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.resolve_owner(p_kind text, p_ref_id text) RETURNS bigint
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE found_id bigint;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('user', 'org') OR p_ref_id IS NULL OR length(p_ref_id) = 0 OR length(p_ref_id) > 200 THEN
    RAISE EXCEPTION 'invalid owner reference' USING ERRCODE = '22023';
  END IF;
  -- Shared with the operator binding function: a first request cannot race the binding.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_kind || ':' || p_ref_id, 0));
  SELECT a.owner_id INTO found_id FROM app.owner_aliases a WHERE a.kind = p_kind AND a.ref_id = p_ref_id;
  IF found_id IS NOT NULL THEN RETURN found_id; END IF;
  INSERT INTO public.owners (kind, ref_id) VALUES (p_kind, p_ref_id)
    ON CONFLICT (kind, ref_id) DO NOTHING RETURNING id INTO found_id;
  IF found_id IS NULL THEN
    SELECT o.id INTO found_id FROM public.owners o WHERE o.kind = p_kind AND o.ref_id = p_ref_id;
  END IF;
  RETURN found_id;
END $$;--> statement-breakpoint

-- Called once by an operator after confirming the Clerk account and data ownership.
-- A conflicting existing owner requires a deliberate data merge, never an implicit reassignment.
CREATE FUNCTION app.bind_clerk_legacy_owner(p_ref_id text) RETURNS bigint
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE legacy_id bigint; existing_id bigint;
BEGIN
  IF p_ref_id IS NULL OR p_ref_id !~ '^clerk:user_[A-Za-z0-9]+$' OR length(p_ref_id) > 200 THEN
    RAISE EXCEPTION 'invalid Clerk owner reference' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('user:' || p_ref_id, 0));
  SELECT o.id INTO legacy_id FROM public.owners o WHERE o.kind = 'user' AND o.ref_id = 'legacy:v1' FOR UPDATE;
  IF legacy_id IS NULL THEN RAISE EXCEPTION 'legacy owner missing'; END IF;
  IF EXISTS (SELECT 1 FROM app.owner_aliases a WHERE a.owner_id = legacy_id AND a.ref_id <> p_ref_id) THEN
    RAISE EXCEPTION 'legacy owner already bound';
  END IF;
  SELECT o.id INTO existing_id FROM public.owners o WHERE o.kind = 'user' AND o.ref_id = p_ref_id;
  IF existing_id IS NOT NULL AND existing_id <> legacy_id THEN
    RAISE EXCEPTION 'Clerk owner already exists; explicit merge required';
  END IF;
  INSERT INTO app.owner_aliases(kind, ref_id, owner_id) VALUES ('user', p_ref_id, legacy_id)
    ON CONFLICT (kind, ref_id) DO NOTHING;
  SELECT a.owner_id INTO existing_id FROM app.owner_aliases a WHERE a.kind = 'user' AND a.ref_id = p_ref_id;
  IF existing_id <> legacy_id THEN RAISE EXCEPTION 'Clerk identity already bound to a different owner'; END IF;
  RETURN legacy_id;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app.bind_clerk_legacy_owner(text) FROM PUBLIC, skillvault_app;--> statement-breakpoint
REVOKE ALL ON FUNCTION app.resolve_owner(text, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.resolve_owner(text, text) TO skillvault_app;
