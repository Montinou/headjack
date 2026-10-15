-- app already exists from migration 0001; adopt it in the generated snapshot.
CREATE SCHEMA IF NOT EXISTS "app";
--> statement-breakpoint
CREATE TABLE "app"."mcp_search_budget" (
	"owner_id" bigint NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"used" integer NOT NULL,
	CONSTRAINT "mcp_search_budget_owner_id_window_start_pk" PRIMARY KEY("owner_id","window_start")
);
--> statement-breakpoint
ALTER TABLE "app"."mcp_search_budget" ADD CONSTRAINT "mcp_search_budget_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- Internal counters have no direct application or PUBLIC access.
REVOKE ALL ON app.mcp_search_budget FROM PUBLIC, skillvault_app;--> statement-breakpoint

-- One short owner transaction consumes one slot before any embedding work begins.
-- The atomic upsert serializes competing requests; the caller cannot choose an owner or clock.
CREATE FUNCTION app.consume_mcp_search_budget() RETURNS TABLE (allowed boolean, retry_after integer)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  owner_id_value bigint := app.current_owner_id();
  database_now timestamptz := clock_timestamp();
  window_start_value timestamptz := date_trunc('minute', database_now);
  used_value integer;
BEGIN
  IF owner_id_value IS NULL OR owner_id_value <= 0
     OR NOT EXISTS (SELECT 1 FROM public.owners o WHERE o.id = owner_id_value) THEN
    RAISE EXCEPTION 'MCP search budget requires a valid owner' USING ERRCODE = '22023';
  END IF;
  INSERT INTO app.mcp_search_budget AS budget (owner_id, window_start, used)
    VALUES (owner_id_value, window_start_value, 1)
    ON CONFLICT (owner_id, window_start) DO UPDATE SET used = budget.used + 1
    RETURNING used INTO used_value;
  RETURN QUERY SELECT used_value <= 60,
    CASE WHEN used_value <= 60 THEN 0
         ELSE greatest(1, least(60, ceil(extract(epoch FROM (window_start_value + interval '1 minute' - database_now)))::integer)) END;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app.consume_mcp_search_budget() FROM PUBLIC, skillvault_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.consume_mcp_search_budget() TO skillvault_app;--> statement-breakpoint

-- Operators invoke cleanup separately; application requests never delete counters.
CREATE FUNCTION app.prune_mcp_search_budget() RETURNS bigint
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    WITH deleted AS (
      DELETE FROM app.mcp_search_budget WHERE window_start < clock_timestamp() - interval '2 minutes' RETURNING 1
    ) SELECT count(*) FROM deleted
  $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app.prune_mcp_search_budget() FROM PUBLIC, skillvault_app;
