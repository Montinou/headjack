import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MCP_TRACES = [
  '.next/server/app/mcp/route.js.nft.json',
  '.next/server/app/.well-known/oauth-protected-resource/mcp/route.js.nft.json',
  '.next/server/app/.well-known/oauth-protected-resource/api/route.js.nft.json',
];

// These compiled routes need runtime artifacts, dependencies and package metadata only.
// Report counts, never private file contents or a list of private paths.
export async function checkMcpTraces(root = process.cwd()) {
  const summaries = [];
  for (const name of MCP_TRACES) {
    const manifest = path.resolve(root, name);
    const trace = JSON.parse(await readFile(manifest, 'utf8'));
    if (!Array.isArray(trace.files) || !trace.files.every((file) => typeof file === 'string')) {
      throw new Error(`${name}: invalid trace files`);
    }
    const forbidden = trace.files.filter((file) => {
      const relative = path.relative(root, path.resolve(path.dirname(manifest), file));
      if (relative.split(path.sep).includes('node_modules')) return false;
      return relative !== 'package.json' && !relative.startsWith(`.next${path.sep}`);
    }).length;
    summaries.push({ manifest: name, files: trace.files.length, forbidden });
  }
  return summaries;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const summaries = await checkMcpTraces();
    for (const summary of summaries) console.log(JSON.stringify(summary));
    if (summaries.some(({ forbidden }) => forbidden > 0)) process.exitCode = 1;
  } catch (error) {
    console.error(`MCP trace check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
