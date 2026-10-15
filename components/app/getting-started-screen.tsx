"use client";
import Link from "next/link";
import { useEffect, type MouseEvent, type ReactNode } from "react";
import { CopyCommand } from "@/components/app/copy-command";
import { GUIDE_COMMANDS } from "@/lib/ui/guide-commands.mjs";

type SectionId = (typeof GUIDE_COMMANDS)[number]["section"];

const SECTIONS: { id: SectionId; title: string }[] = [
  { id: "access", title: "Access and CLI setup" },
  { id: "find", title: "Find a skill" },
  { id: "install", title: "Install locally" },
  { id: "review", title: "Review a source or an upstream change" },
];

// What each command does, keyed by GUIDE_COMMANDS id.
const PURPOSE: Record<string, ReactNode> = {
  help: "List every command and option the CLI accepts.",
  "harness-detect":
    "Find the agent harnesses on this machine that skills can be installed into.",
  search: (
    <>
      Search your library by what you need done. <code>--purpose manual</code>{" "}
      records it as a search you ran yourself.
    </>
  ),
  add: "Install the approved version of a skill.",
  "add-session":
    "Install it as a session install, so that cleanup removes it later.",
  list: "List what is installed, as JSON.",
  verify: "Check the installed skills for problems.",
  "remove-session": (
    <>
      Remove a skill only if it was installed with <code>--session</code>.
    </>
  ),
  updates:
    "List skills whose source repository has commits newer than the recorded ones.",
  review: "Review one skill from a source repository, by path and slug.",
  "import-plan":
    "Preview which skills already on this machine an import would bring in. Nothing is uploaded.",
};

const INTRO: Record<SectionId, ReactNode> = {
  access: (
    <>
      <p>Access is restricted to invited accounts.</p>
      <p>
        Set <code>HEADJACK_URL</code> to this workspace&apos;s address, then
        sign in from the CLI with your browser: <code>headjack login</code>.
        Check the session with <code>headjack whoami</code> and end it with{" "}
        <code>headjack logout</code>.
      </p>
      <p>
        Without a browser, for example on a server, set{" "}
        <code>HEADJACK_TOKEN</code> to an API key, or keep the key in the file{" "}
        <code>token</code> inside the CLI state directory with{" "}
        <code>chmod 600</code>.
      </p>
      <p>
        Agents can search this vault through the read-only MCP server at{" "}
        <code>/mcp</code> on this address; see <code>docs/mcp.md</code> in the
        repository to connect one.
      </p>
    </>
  ),
  find: (
    <p>
      Search from the terminal, or browse the library here with the same
      filters and tags.
    </p>
  ),
  install: (
    <p>
      Downloading an archive does not install anything: it is a copy to
      inspect. Install with the CLI, which places the approved version in your
      agents&apos; skill directories.
    </p>
  ),
  review: (
    <p>
      Check for upstream changes, then review the source again with the CLI.
      The import plan is a dry run: it uploads nothing.
    </p>
  ),
};

const linkClass =
  "text-(--cobalt) underline underline-offset-4 hover:text-(--cobalt-hover)";

// Scrolls to and focuses the section the URL hash names; any other hash is ignored.
// Sections can be taller than the viewport, so the start is aligned explicitly to keep the heading in view.
function focusHashedSection() {
  const id = window.location.hash.slice(1);
  if (!SECTIONS.some((section) => section.id === id)) return;
  const section = document.getElementById(id);
  section?.scrollIntoView({ block: "start" });
  section?.focus({ preventScroll: true });
}

// A plain left click on a rail link moves in place: pushState adds the history entry without the popstate that the
// auth boundary treats as a Back/Forward and answers with a session recheck and remount. Modified clicks keep the browser default.
function followRailLink(event: MouseEvent<HTMLAnchorElement>, id: SectionId) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
    return;
  event.preventDefault();
  if (window.location.hash !== `#${id}`)
    window.history.pushState(null, "", `#${id}`);
  focusHashedSection();
}

// Reading page for the CLI workflow: section rail, four numbered sections of copyable commands, next steps.
export function GettingStartedScreen() {
  // On mount (landing, sign-in, Back remount) and on in-page hash changes.
  useEffect(() => {
    focusHashedSection();
    window.addEventListener("hashchange", focusHashedSection);
    return () => window.removeEventListener("hashchange", focusHashedSection);
  }, []);

  return (
    <div
      data-screen="getting-started"
      className="@container/guide mx-auto flex w-full max-w-6xl flex-col gap-6"
    >
      <header className="flex flex-col gap-2">
        <h1 className="text-[30px] leading-9 font-extrabold tracking-[-0.02em] text-(--ink-title) @2xl/guide:text-[40px] @2xl/guide:leading-[44px]">
          Getting started
        </h1>
        <p className="max-w-2xl text-[15px] leading-6 text-(--ink-muted)">
          Set up the CLI, find a skill, install it locally and review new
          sources.
        </p>
      </header>
      <div className="grid grid-cols-1 gap-6 @min-[960px]/guide:grid-cols-[13rem_minmax(0,1fr)] @min-[960px]/guide:gap-x-10">
        <nav
          aria-label="Getting started sections"
          className="@min-[960px]/guide:sticky @min-[960px]/guide:top-6 @min-[960px]/guide:self-start"
        >
          <ol className="flex flex-wrap gap-x-5 gap-y-2 text-[15px] leading-6 font-semibold @min-[960px]/guide:flex-col @min-[960px]/guide:gap-3 @min-[960px]/guide:border-l @min-[960px]/guide:border-(--rule) @min-[960px]/guide:pl-4">
            {SECTIONS.map((section) => (
              <li key={section.id}>
                <a
                  href={`#${section.id}`}
                  className={linkClass}
                  onClick={(event) => followRailLink(event, section.id)}
                >
                  {section.title}
                </a>
              </li>
            ))}
          </ol>
        </nav>
        <div className="flex min-w-0 max-w-[760px] flex-col gap-6">
          {SECTIONS.map((section, index) => (
            <GuideSection key={section.id} number={index + 1} {...section} />
          ))}
          <nav
            aria-label="Guide next steps"
            className="flex flex-wrap gap-x-6 gap-y-2 border-t border-(--rule) pt-4 text-[15px] leading-6 font-semibold"
          >
            <Link href="/library" className={linkClass}>
              Browse library
            </Link>
            <Link href="/updates" className={linkClass}>
              Detected upstream changes
            </Link>
          </nav>
        </div>
      </div>
    </div>
  );
}

function GuideSection({
  id,
  title,
  number,
}: {
  id: SectionId;
  title: string;
  number: number;
}) {
  const headingId = `${id}-heading`;
  return (
    <section
      id={id}
      tabIndex={-1}
      aria-labelledby={headingId}
      className="paper-card flex min-w-0 scroll-mt-6 flex-col gap-4 p-5 @lg/guide:p-6"
    >
      <header className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="inline-flex size-8 flex-none items-center justify-center rounded-full bg-(--cobalt-soft) text-[15px] font-bold text-(--cobalt)"
        >
          {number}
        </span>
        <h2
          id={headingId}
          className="text-[22px] leading-7 font-bold text-(--ink-title)"
        >
          {title}
        </h2>
      </header>
      <div className="flex max-w-prose flex-col gap-2 text-[15px] leading-6 text-(--ink) [&_code]:font-mono [&_code]:text-[14px]">
        {INTRO[id]}
      </div>
      <ul className="rule-list flex min-w-0 flex-col border-t border-(--rule)">
        {GUIDE_COMMANDS.filter((entry) => entry.section === id).map((entry) => (
          <li key={entry.id} className="flex min-w-0 flex-col gap-2 py-4 last:pb-0">
            <p className="text-[15px] leading-6 text-(--ink) [&_code]:font-mono [&_code]:text-[14px] [&_code]:whitespace-nowrap">
              {PURPOSE[entry.id]}
            </p>
            <CopyCommand
              className="guide-command"
              command={entry.command}
              label={entry.label}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
