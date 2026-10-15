"use client";
import Link from "next/link";
import { useId, type ReactNode } from "react";
import { skillHref } from "@/components/app/skill-card";
import { StatusCard } from "@/components/app/status-card";
import { usePrivateResource } from "@/components/premium/use-private-resource";
import { RecordedDate } from "@/components/premium/review-metadata";
import { safeSourceUrl } from "@/lib/ui/commands.mjs";
import type { UpdatesResponse, UpstreamUpdate } from "@/lib/ui/contracts";

const NOT_RECORDED = "Not recorded";
const LOAD_ERROR = "Unable to load upstream updates. Try again.";

const linkClass =
  "text-(--cobalt) underline underline-offset-4 hover:text-(--cobalt-hover)";

// Read-only list of detected upstream changes: no publish, update or review actions.
export function UpdatesScreen() {
  const resource = usePrivateResource<UpdatesResponse>("/api/updates");
  const noteId = useId();
  const updates: unknown =
    resource.state === "success" ? resource.data?.updates : null;

  let content: ReactNode;
  if (resource.state === "error" && resource.error?.status === 403)
    content = (
      <StatusCard
        state="forbidden"
        message="Your account does not have access to upstream updates."
      />
    );
  else if (
    resource.state === "error" ||
    (resource.state === "success" && !Array.isArray(updates))
  )
    content = (
      <StatusCard state="error" message={LOAD_ERROR} onRetry={resource.retry} />
    );
  else if (!Array.isArray(updates))
    content = (
      <StatusCard
        state="loading"
        message="Checking detected upstream changes…"
      />
    );
  else if (!updates.length)
    content = (
      <div className="flex flex-col items-center gap-1">
        <StatusCard state="empty" message="No upstream changes detected." />
        <p className="-mt-6 max-w-prose text-center text-[15px] leading-6 text-(--ink-muted)">
          An empty list does not verify that every skill is unchanged.
        </p>
      </div>
    );
  else
    content = (
      <ul className="flex flex-col gap-4">
        {(updates as UpstreamUpdate[]).map((update, index) => (
          <li key={`${update.slug}:${index}`} className="min-w-0">
            <UpdateEntry update={update} />
          </li>
        ))}
      </ul>
    );

  return (
    <div
      data-screen="updates"
      className="@container/updates mx-auto flex w-full max-w-6xl flex-col gap-6"
    >
      <header className="flex flex-col gap-2">
        <h1 className="text-[30px] leading-9 font-extrabold tracking-[-0.02em] text-(--ink-title) @2xl/updates:text-[40px] @2xl/updates:leading-[44px]">
          Detected upstream changes
        </h1>
        <p className="max-w-2xl text-[15px] leading-6 text-(--ink-muted)">
          Skills whose source repository has commits newer than the ones
          recorded for them.
        </p>
      </header>
      {/* The note precedes the list in DOM order: above it on narrow widths,
          a side card from 960 px of content width. */}
      <div className="grid grid-cols-1 gap-6 @min-[960px]/updates:grid-cols-[minmax(0,1fr)_18rem] @min-[960px]/updates:gap-x-10">
        <aside
          aria-labelledby={noteId}
          className="paper-card flex flex-col gap-2 p-5 @min-[960px]/updates:sticky @min-[960px]/updates:top-6 @min-[960px]/updates:col-start-2 @min-[960px]/updates:row-start-1 @min-[960px]/updates:self-start"
        >
          <h2
            id={noteId}
            className="text-[18px] leading-6 font-semibold text-(--ink-title)"
          >
            About upstream detection
          </h2>
          <p className="text-[15px] leading-6 text-(--ink)">
            Detection is repository-level: a new commit anywhere in a
            skill&apos;s source repository flags it, so a listed change does
            not confirm that the skill&apos;s own files changed.
          </p>
        </aside>
        <div className="flex min-w-0 flex-col gap-6 @min-[960px]/updates:col-start-1 @min-[960px]/updates:row-start-1">
          {content}
          <nav
            aria-label="Updates next steps"
            className="flex flex-wrap gap-x-6 gap-y-2 border-t border-(--rule) pt-4 text-[15px] leading-6 font-semibold"
          >
            <Link href="/library" className={linkClass}>
              Browse library
            </Link>
            <Link href="/getting-started#review" className={linkClass}>
              Review with the CLI
            </Link>
          </nav>
        </div>
      </div>
    </div>
  );
}

function UpdateEntry({ update }: { update: UpstreamUpdate }) {
  const href = safeSourceUrl(update.source_url);
  return (
    <article className="paper-card flex min-w-0 flex-col gap-4 p-5">
      <header className="flex min-w-0 flex-col gap-1">
        <h2 className="text-[18px] leading-6 font-semibold wrap-anywhere">
          <Link href={skillHref(update.slug)} className={linkClass}>
            {update.name}
          </Link>
        </h2>
        <p className="font-mono text-[13px] leading-[18px] wrap-anywhere text-(--ink-muted)">
          {update.slug}
        </p>
      </header>
      <dl className="flex min-w-0 flex-col gap-3 border-t border-(--rule) pt-4">
        <Field label="Source repository">
          {href ? (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className={linkClass}
            >
              {update.source_url}
            </a>
          ) : (
            update.source_url || NOT_RECORDED
          )}
        </Field>
        <Field label="Source path">{update.source_path || NOT_RECORDED}</Field>
        <Field label="Current approved commit">
          <Commit value={update.current_commit} />
        </Field>
        <Field label="Latest reviewed commit">
          <Commit value={update.reviewed_commit} />
        </Field>
        <Field label="Latest upstream commit">
          <Commit value={update.latest_commit} />
        </Field>
        <Field label="Last checked">
          <RecordedDate value={update.checked_at} />
        </Field>
      </dl>
    </article>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-1 @lg/updates:grid-cols-[12rem_minmax(0,1fr)] @lg/updates:gap-6">
      <dt className="text-[13px] leading-[22px] font-semibold text-(--ink-muted)">
        {label}
      </dt>
      <dd className="min-w-0 text-[15px] leading-[22px] wrap-anywhere text-(--ink)">
        {children}
      </dd>
    </div>
  );
}

function Commit({ value }: { value: string | null }) {
  if (!value) return <>{NOT_RECORDED}</>;
  return (
    <span className="font-mono text-[13px] break-all select-text">{value}</span>
  );
}
