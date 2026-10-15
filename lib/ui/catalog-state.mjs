import { MAX_TAGS, normalizeTag } from "../tags.mjs";
export const BROWSE_LIMIT = 24;
export const SEARCH_LIMIT = 25;
export function parseCatalogState(params) {
  const kind = params.get("kind") || null;
  const view = params.get("view") || "grid";
  const offsetRaw = params.get("offset") ?? "0";
  const offset = Number(offsetRaw);
  const tags = [
    ...new Set(
      params
        .getAll("tag")
        .flatMap((v) => v.split(","))
        .map((v) => v.trim())
        .filter(Boolean)
        .map(normalizeTag),
    ),
  ];
  if (kind && kind !== "skill" && kind !== "plugin")
    throw new Error("Invalid kind. Choose skill or plugin.");
  if (view !== "grid" && view !== "list")
    throw new Error("Invalid view. Choose grid or list.");
  if (!/^\d+$/.test(offsetRaw) || !Number.isSafeInteger(offset) || offset < 0)
    throw new Error("Invalid offset. Use a nonnegative integer.");
  if (tags.length > MAX_TAGS || tags.some((tag) => !tag))
    throw new Error(
      "Invalid tags. Use letters or digits, with at most 8 tags.",
    );
  return { q: (params.get("q") ?? "").trim(), kind, tags, view, offset };
}
export function serializeCatalogState(state) {
  const params = new URLSearchParams();
  if (state.q) params.set("q", state.q);
  if (state.kind) params.set("kind", state.kind);
  for (const tag of state.tags) params.append("tag", tag);
  if (state.view !== "grid") params.set("view", state.view);
  if (state.offset) params.set("offset", String(state.offset));
  return params;
}
export function changeCatalogState(state, patch) {
  const next = { ...state, ...patch };
  if (
    next.q !== state.q ||
    next.kind !== state.kind ||
    JSON.stringify(next.tags) !== JSON.stringify(state.tags)
  )
    next.offset = 0;
  return next;
}
