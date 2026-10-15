export type SkillKind = "skill" | "plugin";
export type SkillSummary = {
  slug: string;
  name: string;
  description: string;
  kind: SkillKind;
  plugin_slug: string | null;
  tags: string[];
  update_available: boolean;
};
export type CatalogSkill = SkillSummary & {
  quality: Record<string, unknown> | null;
  has_approved_version: boolean;
};
export type SearchSkill = SkillSummary & {
  score: number;
  fts_rank: number | null;
  vector_rank: number | null;
  similarity: number | null;
  matched: "both" | "vector" | "fts";
  variant: "rrf-english" | "rrf-bilingual";
  alternatives?: string[];
};
export type CatalogResponse = {
  skills: CatalogSkill[];
  total: number;
  limit: number;
  offset: number;
};
export type SearchResponse = { results: SearchSkill[] };
export type DisplaySkill = SkillSummary & {
  approved: boolean;
  quality: Record<string, unknown> | null;
  alternatives?: string[];
};
export type CatalogState = {
  q: string;
  kind: SkillKind | null;
  tags: string[];
  view: "grid" | "list";
  offset: number;
};
export type SkillDetailRecord = SkillSummary & {
  quality: Record<string, unknown> | null;
  source_kind: string | null;
  source_url: string | null;
  default_ref: string | null;
  source_path: string | null;
  commit_sha: string | null;
  sha256: string | null;
  size: number | null;
  reviewed_at: string | null;
  review_notes: string | null;
  scan_flags: unknown[] | null;
  latest_commit: string | null;
};
export type ReviewRecord = {
  commit_sha: string | null;
  sha256: string;
  status: string;
  reviewed_at: string | null;
  review_notes: string | null;
  current: boolean;
};
export type VersionRecord = ReviewRecord & {
  id: number;
  size: number | null;
  scan_flags: unknown[] | null;
};
export type UpstreamUpdate = {
  slug: string;
  name: string;
  current_commit: string | null;
  reviewed_commit: string | null;
  latest_commit: string | null;
  checked_at: string | null;
  source_url: string | null;
  source_path: string | null;
};
export type UpdatesResponse = { updates: UpstreamUpdate[] };
