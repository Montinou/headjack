-- Requests delete only their own owner's expired counters (spec D4), so the table stays bounded without an operator job.
-- CREATE OR REPLACE keeps the 0007 signature, return shape and ownership; the grants are re-issued below to stay explicit.
CREATE OR REPLACE FUNCTION app.consume_mcp_search_budget() RETURNS TABLE (allowed boolean, retry_after integer)
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
  DELETE FROM app.mcp_search_budget
    WHERE owner_id = owner_id_value AND window_start < window_start_value - interval '1 minute';
  INSERT INTO app.mcp_search_budget AS budget (owner_id, window_start, used)
    VALUES (owner_id_value, window_start_value, 1)
    ON CONFLICT (owner_id, window_start) DO UPDATE SET used = budget.used + 1
    RETURNING used INTO used_value;
  RETURN QUERY SELECT used_value <= 60,
    CASE WHEN used_value <= 60 THEN 0
         ELSE greatest(1, least(60, ceil(extract(epoch FROM (window_start_value + interval '1 minute' - database_now)))::integer)) END;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app.consume_mcp_search_budget() FROM PUBLIC, skillvault_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.consume_mcp_search_budget() TO skillvault_app;
