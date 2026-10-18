import { skillAddCommand } from "./commands.mjs";

// Getting started commands (spec Appendix A). Each one is a valid invocation of the USAGE in cli/headjack.mjs
// (pinned by test/unit/ui-guide-commands.test.mjs); none uploads: the import step is only the dry-run plan.

/** @type {Array<{ id: string; section: "access" | "find" | "install" | "review"; label: string; command: string }>} */
export const GUIDE_COMMANDS = [
  { id: "help", section: "access", label: "help", command: "headjack --help" },
  { id: "harness-detect", section: "access", label: "harness detect", command: "headjack harness detect" },
  {
    id: "search",
    section: "find",
    label: "search",
    command: 'headjack search --purpose manual -- "render a video with remotion"',
  },
  { id: "suggest-enable", section: "find", label: "suggestions", command: "headjack suggest --enable --hosted" },
  { id: "add", section: "install", label: "install", command: skillAddCommand("your-skill") },
  { id: "add-session", section: "install", label: "session install", command: "headjack add --session -- 'your-skill'" },
  { id: "pull", section: "install", label: "pull", command: "headjack pull" },
  { id: "list", section: "install", label: "list", command: "headjack list --json" },
  { id: "verify", section: "install", label: "verify", command: "headjack verify" },
  {
    id: "remove-session",
    section: "install",
    label: "session remove",
    command: "headjack remove --if-session -- 'your-skill'",
  },
  { id: "updates", section: "review", label: "updates", command: "headjack updates" },
  {
    id: "review",
    section: "review",
    label: "review",
    command:
      "headjack review --path 'skills/your-skill' --slug 'your-skill' -- 'https://github.com/owner/repository'",
  },
  { id: "import-plan", section: "review", label: "import plan", command: "headjack import --dry-run" },
];
