// POSIX shell operand quoting; -- prevents a leading hyphen becoming an option.
export function skillAddCommand(slug) {
  return `headjack add -- '${slug.replaceAll("'", "'\\''")}'`;
}
export function safeSourceUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
