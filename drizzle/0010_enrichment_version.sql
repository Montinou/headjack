ALTER TABLE "skills" ADD COLUMN "enrichment_v" integer;--> statement-breakpoint
-- Existing Spanish text was written by the version-1 prompt (spec §6.3); no model call.
UPDATE "skills" SET "enrichment_v" = 1 WHERE "queries_es_text" <> '';
