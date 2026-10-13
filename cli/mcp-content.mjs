// Reads the text of a skill for the MCP tools. A stored archive is untrusted data: it is validated whole before the root
// SKILL.md is picked, the text is decoded strictly and cut to a small size. Every failure is one fixed code, never a message.
import { unpack } from '../lib/tar.mjs';

export const ARCHIVE_BYTES = 16 * 1024 * 1024;
export const CONTENT_BYTES = 8192;

const unavailable = () => ({ skill_md: null, truncated: false, content_status: 'unavailable' });
const contentError = () => Object.assign(new Error('content_unavailable'), { code: 'content_unavailable' });

// A plugin is enabled through settings and has no archive of its own.
export const isPlugin = (row) => row.kind === 'plugin' || row.plugin_slug != null;

// row: the skill's metadata (kind, plugin_slug); tarball: the downloaded archive, or null when there is none.
// -> { skill_md, truncated, content_status }
export function readSkillContent(row, tarball) {
  if (isPlugin(row) || tarball == null) return unavailable();
  try {
    if (!(tarball instanceof Uint8Array) || tarball.byteLength > ARCHIVE_BYTES) throw new Error('refused');
    const root = unpack(tarball, { maxOutputLength: ARCHIVE_BYTES }).find((file) => file.path === 'SKILL.md');
    if (!root) return unavailable();
    // Invalid UTF-8 anywhere in the file is refused: it must not become replacement characters in the original text.
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    decoder.decode(root.data);
    const truncated = root.data.length > CONTENT_BYTES;
    let end = Math.min(root.data.length, CONTENT_BYTES);
    // Back off to the start of the character the cut would split.
    if (truncated) while (end > 0 && (root.data[end] & 0xc0) === 0x80) end -= 1;
    return { skill_md: decoder.decode(root.data.subarray(0, end)), truncated, content_status: 'available' };
  } catch {
    throw contentError();
  }
}
