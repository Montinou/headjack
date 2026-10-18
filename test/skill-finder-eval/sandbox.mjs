// Builds one sandbox per scenario for evaluating skill-finder with agents: a temp HOME (so `--to claude` lands in
// <sandbox>/home/.claude/skills), the fixture vault, the scenario's project files, and a `headjack` wrapper on PATH that
// appends each invocation to <sandbox>/commands.log before running the real CLI.
//   node test/skill-finder-eval/sandbox.mjs <out-dir>     prints one line per scenario: <id> <sandbox dir>
// An agent runs every command as: source <sandbox>/env.sh && <command>, from <sandbox>/project.
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSkillFinderVault } from '../skill-finder-vault.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const SCENARIOS = JSON.parse(await readFile(new URL('./scenarios.json', import.meta.url), 'utf8'));

const q = (s) => `'${s.replaceAll("'", "'\\''")}'`;

export async function buildSandbox(dir, scenario) {
  const home = path.join(dir, 'home');
  const state = path.join(dir, 'state');
  const project = path.join(dir, 'project');
  const bin = path.join(dir, 'bin');
  for (const d of [home, state, project, bin, path.join(home, '.claude/skills')]) await mkdir(d, { recursive: true });
  if (scenario.vault !== false) await buildSkillFinderVault(state);
  for (const [rel, content] of Object.entries(scenario.files)) {
    await mkdir(path.dirname(path.join(project, rel)), { recursive: true });
    await writeFile(path.join(project, rel), content);
  }
  const log = path.join(dir, 'commands.log');
  await writeFile(log, '');
  const wrapper = path.join(bin, 'headjack');
  await writeFile(wrapper, `#!/bin/sh\nprintf 'headjack %s\\n' "$*" >> ${q(log)}\nexec ${q(path.join(ROOT, 'cli/headjack'))} "$@"\n`);
  await chmod(wrapper, 0o755);
  await writeFile(path.join(dir, 'env.sh'), [
    `export HOME=${q(home)}`, `export HEADJACK_HOME=${q(state)}`, 'export HEADJACK_MODE=local', 'unset HEADJACK_URL HEADJACK_TOKEN',
    `export PATH=${q(bin)}:"$PATH"`, `cd ${q(project)}`, '',
  ].join('\n'));
  return dir;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) {
    console.error('usage: node test/skill-finder-eval/sandbox.mjs <out-dir>');
    process.exit(2);
  }
  for (const s of SCENARIOS) console.log(`${s.id} ${await buildSandbox(path.resolve(process.argv[2], s.id), s)}`);
}
