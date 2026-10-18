// Prepares one evaluation round of skill-finder: a sandbox per scenario (sandbox.mjs) and the prompt an agent gets for it,
// with the skill under test pasted in. Hand each agent "read <prompt file> and act on it"; afterwards grade the agent's
// answer and <sandbox>/commands.log against the scenario's `pass` lines.
//   node test/skill-finder-eval/prepare.mjs <SKILL.md> <out-dir> [scenario-id…]
//   prints one line per scenario: <id> <prompt file> <commands.log>
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SCENARIOS, buildSandbox } from './sandbox.mjs';

const [skillPath, outDir, ...only] = process.argv.slice(2);
if (!skillPath || !outDir) {
  console.error('usage: node test/skill-finder-eval/prepare.mjs <SKILL.md> <out-dir> [scenario-id…]');
  process.exit(2);
}
const template = await readFile(new URL('./agent-prompt.md', import.meta.url), 'utf8');
const skill = await readFile(skillPath, 'utf8');
for (const s of SCENARIOS.filter((x) => only.length === 0 || only.includes(x.id))) {
  const sandbox = await buildSandbox(path.resolve(outDir, s.id), s);
  const prompt = template.replace('{{SKILL}}', () => skill).replaceAll('{{SANDBOX}}', sandbox).replace('{{PROMPT}}', () => s.prompt);
  const file = path.join(sandbox, 'prompt.md');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, prompt);
  console.log(`${s.id} ${file} ${path.join(sandbox, 'commands.log')}`);
}
