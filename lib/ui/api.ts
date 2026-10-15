export const PRIVATE_SESSION_EXPIRED_EVENT =
  "headjack-private-session-expired";
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown) =>
  Array.isArray(value) && value.every((v) => typeof v === "string");
const integer = (value: unknown) =>
  Number.isSafeInteger(value) && Number(value) >= 0;
function summary(row: unknown): row is Record<string, unknown> {
  return (
    object(row) &&
    ["slug", "name", "description"].every(
      (key) => typeof row[key] === "string",
    ) &&
    ["skill", "plugin"].includes(String(row.kind)) &&
    (row.plugin_slug === null || typeof row.plugin_slug === "string") &&
    strings(row.tags) &&
    typeof row.update_available === "boolean"
  );
}
function validEnvelope(path: string, body: unknown) {
  if (!object(body)) return false;
  const pathname = path.split("?")[0];
  if (pathname === "/api/skills")
    return (
      Array.isArray(body.skills) &&
      body.skills.every(
        (row) =>
          summary(row) &&
          typeof row.has_approved_version === "boolean" &&
          (row.quality === null || object(row.quality)),
      ) &&
      integer(body.total) &&
      integer(body.limit) &&
      Number(body.limit) > 0 &&
      integer(body.offset)
    );
  if (pathname === "/api/search")
    return (
      Array.isArray(body.results) &&
      body.results.every(
        (row) =>
          summary(row) &&
          typeof row.score === "number" &&
          Number.isFinite(row.score) &&
          ["fts_rank", "vector_rank", "similarity"].every(
            (key) =>
              row[key] === null ||
              (typeof row[key] === "number" && Number.isFinite(row[key])),
          ) &&
          ["fts", "vector", "both"].includes(String(row.matched)) &&
          ["rrf-english", "rrf-bilingual"].includes(String(row.variant)) &&
          (row.alternatives === undefined || strings(row.alternatives)),
      )
    );
  return true;
}
export async function apiJson<T>(
  path: string,
  signal: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      signal,
      credentials: "same-origin",
      cache: "no-store",
      headers:
        path.split("?")[0] === "/api/search"
          ? { "x-headjack-purpose": "manual" }
          : {},
    });
  } catch (error) {
    if (
      signal.aborted ||
      (error instanceof Error && error.name === "AbortError")
    )
      throw error;
    throw new ApiError(
      0,
      "Unable to connect. Check your connection and try again.",
    );
  }
  if (!response.ok && response.status >= 500)
    throw new ApiError(
      response.status,
      "This content is temporarily unavailable. Try again in a moment.",
    );
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiError(
      response.ok ? 502 : response.status,
      "The server returned an unreadable response. Try again.",
    );
  }
  if (!response.ok) {
    const message =
      object(body) &&
      object(body.error) &&
      typeof body.error.message === "string"
        ? body.error.message
        : "Unable to load this content. Try again.";
    throw new ApiError(response.status, message);
  }
  if (!validEnvelope(path, body))
    throw new ApiError(
      502,
      "The server returned an incomplete response. Try again.",
    );
  return body as T;
}
