import { unpack } from '../tar.mjs';
import { MCP_LIMITS } from './config.mjs';
const unavailable = () => ({ skill_md: null, truncated: false, content_status: 'unavailable' });

// Stored content is untrusted data. Validate the entire archive before selecting the exact root file.
export function readSkillContent(row, tarball) {
  if (row.kind === 'plugin' || row.plugin_slug != null || tarball == null) return unavailable();
  try {
    if (!(tarball instanceof Uint8Array) || tarball.byteLength > MCP_LIMITS.archiveBytes) throw new Error();
    const root = unpack(tarball, { maxOutputLength: MCP_LIMITS.archiveBytes }).find((file) => file.path === 'SKILL.md');
    if (!root) return unavailable();
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    decoder.decode(root.data); // Invalid UTF-8 must not create replacement characters in the original.
    const truncated = root.data.length > MCP_LIMITS.contentBytes;
    let end = Math.min(root.data.length, MCP_LIMITS.contentBytes);
    if (truncated) while ((root.data[end] & 0xc0) === 0x80) end--;
    return { skill_md: decoder.decode(root.data.subarray(0, end)), truncated, content_status: 'available' };
  } catch {
    throw Object.assign(new Error('content_unavailable'), { code: 'content_unavailable' });
  }
}
