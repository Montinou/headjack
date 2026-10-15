CREATE TABLE "install_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"owner_id" bigint DEFAULT app.current_owner_id() NOT NULL,
	"session_id" text,
	"slug" text NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "install_events_kind_check" CHECK ("install_events"."kind" in ('skill','plugin')),
	CONSTRAINT "install_events_source_check" CHECK ("install_events"."source" in ('suggest','plan','manual'))
);
--> statement-breakpoint
ALTER TABLE "install_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "search_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"owner_id" bigint DEFAULT app.current_owner_id() NOT NULL,
	"session_id" text NOT NULL,
	"variant" text NOT NULL,
	"query_hmac" text NOT NULL,
	"top_slugs" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "search_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "queries_es_text" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "fts_es" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('spanish', queries_es_text), 'B')) STORED;--> statement-breakpoint
ALTER TABLE "install_events" ADD CONSTRAINT "install_events_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_events" ADD CONSTRAINT "search_events_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "install_events_owner_session_created_idx" ON "install_events" USING btree ("owner_id","session_id","created_at");--> statement-breakpoint
CREATE INDEX "search_events_owner_session_created_idx" ON "search_events" USING btree ("owner_id","session_id","created_at");--> statement-breakpoint
CREATE INDEX "skills_fts_es_idx" ON "skills" USING gin ("fts_es");--> statement-breakpoint
CREATE POLICY "install_events_owner" ON "install_events" AS PERMISSIVE FOR ALL TO "skillvault_app" USING (owner_id = app.current_owner_id()) WITH CHECK (owner_id = app.current_owner_id());--> statement-breakpoint
CREATE POLICY "search_events_owner" ON "search_events" AS PERMISSIVE FOR ALL TO "skillvault_app" USING (owner_id = app.current_owner_id()) WITH CHECK (owner_id = app.current_owner_id());--> statement-breakpoint
-- Hand-appended (as in 0004_rls.sql): FORCE RLS and the app role's grants for the event tables. DELETE is for the
-- 90-day retention run by the cron.
ALTER TABLE "search_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "install_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "search_events" TO skillvault_app;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "install_events" TO skillvault_app;--> statement-breakpoint
GRANT USAGE ON SEQUENCE "search_events_id_seq", "install_events_id_seq" TO skillvault_app;
