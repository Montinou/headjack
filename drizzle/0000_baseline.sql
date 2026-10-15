CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "chunks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"skill_id" bigint NOT NULL,
	"version_id" bigint NOT NULL,
	"text" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"kind" text DEFAULT 'content' NOT NULL,
	CONSTRAINT "chunks_kind_check" CHECK ("chunks"."kind" in ('content','query'))
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"kind" text NOT NULL,
	"plugin_slug" text,
	"source_id" bigint,
	"source_path" text,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"current_version_id" bigint,
	"quality" jsonb,
	"tags_text" text DEFAULT '' NOT NULL,
	"fts" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', name), 'A') || setweight(to_tsvector('english', tags_text), 'B') || setweight(to_tsvector('english', description), 'C')) STORED,
	CONSTRAINT "skills_slug_key" UNIQUE("slug"),
	CONSTRAINT "skills_kind_check" CHECK ("skills"."kind" in ('skill','plugin'))
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"url" text,
	"default_ref" text DEFAULT 'HEAD' NOT NULL,
	CONSTRAINT "sources_kind_url_key" UNIQUE NULLS NOT DISTINCT("kind","url"),
	CONSTRAINT "sources_kind_check" CHECK ("sources"."kind" in ('github','git','marketplace','local'))
);
--> statement-breakpoint
CREATE TABLE "upstream" (
	"skill_id" bigint PRIMARY KEY NOT NULL,
	"latest_commit" text,
	"checked_at" timestamp with time zone,
	"update_available" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "versions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"skill_id" bigint NOT NULL,
	"commit_sha" text,
	"sha256" text NOT NULL,
	"tarball" "bytea",
	"size" integer,
	"status" text NOT NULL,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"review_notes" text,
	"scan_flags" jsonb DEFAULT '[]' NOT NULL,
	CONSTRAINT "versions_skill_id_sha256_key" UNIQUE("skill_id","sha256"),
	CONSTRAINT "versions_status_check" CHECK ("versions"."status" in ('approved','rejected'))
);
--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_skill_id_fkey" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "public"."versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_current_version_id_fkey" FOREIGN KEY ("current_version_id") REFERENCES "public"."versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upstream" ADD CONSTRAINT "upstream_skill_id_fkey" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "versions" ADD CONSTRAINT "versions_skill_id_fkey" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chunks_embedding_idx" ON "chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "skills_fts_idx" ON "skills" USING gin ("fts");