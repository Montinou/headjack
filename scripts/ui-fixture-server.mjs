// Local fixture QA. Never deploy this copy; production imports no fixture code.
import { mkdtemp, mkdir, cp, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { spawn, execFileSync } from "node:child_process";
const root = resolve(import.meta.dirname, "..");
const [mode, port] = process.argv.slice(2);
if (!["fixture", "unmocked"].includes(mode) || !/^\d+$/.test(port ?? ""))
  throw new Error("Expected fixture|unmocked and configured port");
const copy = await mkdtemp(join(tmpdir(), `headjack-${mode}-qa-`));
// Include the current tracked application source and pending application additions for RED/GREEN.
// No env files, git metadata, documentation/private evidence or local configuration is copied.
const source = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: root },
)
  .toString()
  .split("\0");
const allowed =
  /^(app\/|components\/|hooks\/|lib\/|public\/|flags\.ts$|proxy\.ts$|next\.config\.ts$|postcss\.config\.mjs$|tsconfig\.json$|package(?:-lock)?\.json$)/;
for (const file of source.filter(
  (file) =>
    allowed.test(file) &&
    !file.split("/").some((part) => part.startsWith(".env")),
)) {
  await mkdir(dirname(join(copy, file)), { recursive: true });
  await cp(join(root, file), join(copy, file));
}
await mkdir(join(copy, "public"), { recursive: true });
await writeFile(join(copy, "public/qa-ready.css"), "/* local QA readiness */");
await symlink(join(root, "node_modules"), join(copy, "node_modules"), "dir");
await writeFile(
  join(copy, "FIXTURE-QA-NEVER-DEPLOY.txt"),
  "Isolated local QA copy. Not a deployment artifact.\n",
);
if (mode === "fixture") {
  await cp(join(root, "test/browser/fixtures"), join(copy, "qa-fixtures"), {
    recursive: true,
  });
  await cp(join(copy, "qa-fixtures/flags.ts"), join(copy, "flags.ts"));
  await cp(join(copy, "qa-fixtures/proxy.ts"), join(copy, "proxy.ts"));
  await mkdir(join(copy, "app/fixture-clerk-reload"), { recursive: true });
  await writeFile(
    join(copy, "app/fixture-clerk-reload/route.ts"),
    `export function GET() {return Response.json({isLoaded:true,userId:'owner_a',sessionId:'session_a',status:'active'});}`,
  );
  // A test-only sibling consumer exercises shared unauthorized presentation invalidation.
  await mkdir(join(copy, "app/qa-private-resources"), { recursive: true });
  await writeFile(
    join(copy, "app/qa-private-resources/page.tsx"),
    `"use client";
import {usePrivateResource} from '@/components/premium/use-private-resource';
export default function PrivateResources() {
 const first=usePrivateResource<{name:string}>('/api/qa-first');
 const second=usePrivateResource<{name:string}>('/api/qa-second');
 return <><p>{first.data?.name}</p><p>{second.data?.name}</p></>;
}`,
  );
  // Webpack alias is generated only inside this isolated temporary application.
  await rm(join(copy, "next.config.ts"));
  await writeFile(
    join(copy, "next.config.mjs"),
    `import path from 'node:path';\nexport default { poweredByHeader: false, webpack(config) { config.resolve.alias['@clerk/nextjs$'] = path.resolve('qa-fixtures/clerk.tsx'); return config; } };\n`,
  );
}
const runtimeKeys = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "NODE_EXTRA_CA_CERTS",
];
const env = Object.fromEntries(
  runtimeKeys
    .filter((key) => process.env[key])
    .map((key) => [key, process.env[key]]),
);
if (mode === "unmocked") env.FLAGS_SECRET = process.env.FLAGS_SECRET;
// Nonfunctional app-role URL: unauthorized requests must return before opening a DB transaction.
env.DATABASE_URL_APP =
  "postgresql://headjack_app:local-qa" + "@localhost:1/fixture_qa";
env.CLERK_AUTHORIZED_PARTIES = `http://localhost:${port}`;
if (mode === "fixture") {
  env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY =
    "pk_test_" + "Zml4dHVyZS5jbGVyay5hY2NvdW50cy5kZXYk";
  env.CLERK_SECRET_KEY = "sk_test_fixture_qa_never_a_credential";
}
// Webpack is required for the fixture alias and for temporary node_modules symlinks.
// Turbopack rejects that required symlink outside its temporary filesystem root.
const child = spawn(
  process.execPath,
  [
    join(root, "node_modules/next/dist/bin/next"),
    "dev",
    "--webpack",
    "--port",
    port,
  ],
  { cwd: copy, env, stdio: "inherit" },
);
console.log(
  `${mode === "fixture" ? "FIXTURE QA — NEVER DEPLOY" : "UNMOCKED missing-key configuration smoke"}: ${copy}`,
);
// Wait for the child to exit before deleting its unique temporary checkout.
let cleanupPromise;
function cleanup() {
  return (cleanupPromise ??= rm(copy, { recursive: true, force: true }));
}
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.on("SIGINT", () => child.kill("SIGINT"));
child.on("exit", (code) => {
  void cleanup().then(() => process.exit(code ?? 1));
});
