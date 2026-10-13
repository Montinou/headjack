// Default --to: the built-in trio. Other tools are opt-in by id (or `all` = every detected one).
export const HARNESSES = ['claude', 'codex', 'grok'];

// id → skills dir relative to $HOME (global) and to the repo (project; null = no project-level dir known).
export const KNOWN_HARNESSES = {
  claude: { global: '.claude/skills', project: '.claude/skills' },
  codex: { global: '.codex/skills', project: '.codex/skills' },
  grok: { global: '.grok/skills', project: '.grok/skills' },
  gemini: { global: '.gemini/skills', project: null },
  cursor: { global: '.cursor/skills', project: null },
  continue: { global: '.continue/skills', project: null },
  copilot: { global: '.copilot/skills', project: null },
  kiro: { global: '.kiro/skills', project: null },
  factory: { global: '.factory/skills', project: null },
  openclaw: { global: '.openclaw/skills', project: null },
  roo: { global: '.roo/skills', project: null },
  kilocode: { global: '.kilocode/skills', project: null },
  qwen: { global: '.qwen/skills', project: null },
  trae: { global: '.trae/skills', project: null },
  qoder: { global: '.qoder/skills', project: null },
  junie: { global: '.junie/skills', project: null },
  zencoder: { global: '.zencoder/skills', project: null },
  codebuddy: { global: '.codebuddy/skills', project: null },
  commandcode: { global: '.commandcode/skills', project: null },
  openhands: { global: '.openhands/skills', project: null },
  neovate: { global: '.neovate/skills', project: null },
  pochi: { global: '.pochi/skills', project: null },
  kode: { global: '.kode/skills', project: null },
  mux: { global: '.mux/skills', project: null },
  windsurf: { global: '.codeium/windsurf/skills', project: null },
  cline: { global: '.cline/skills', project: null },
  pi: { global: '.pi/agent/skills', project: null },
};
