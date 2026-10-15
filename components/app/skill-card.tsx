import Link from "next/link";
import { Button } from "@/components/ui/button";
import { IconTile } from "@/components/app/icon-tile";
import { cn } from "@/lib/utils";
import type { DisplaySkill } from "@/lib/ui/contracts";

export const skillHref = (slug: string) => `/skills/${encodeURIComponent(slug)}`;

export function kindLabel(skill: Pick<DisplaySkill, "kind" | "plugin_slug">) {
  if (skill.kind === "plugin") return "Plugin";
  return skill.plugin_slug ? `Skill in ${skill.plugin_slug}` : "Skill";
}

// Recorded verdicts are shown as plain text; anything else reads "Not recorded".
export function verdictOf(quality: DisplaySkill["quality"]) {
  const verdict = quality?.verdict;
  return ["string", "number", "boolean"].includes(typeof verdict)
    ? String(verdict)
    : "Not recorded";
}

function Dot({ tone }: { tone: "success" | "warning" | "muted" }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "mt-[5px] size-2 shrink-0 rounded-full",
        tone === "success" && "bg-(--success)",
        tone === "warning" && "bg-(--warning)",
        tone === "muted" && "border border-(--ink-muted)",
      )}
    />
  );
}

export function Availability({ skill }: { skill: DisplaySkill }) {
  if (skill.approved)
    return (
      <p className="flex gap-2 text-(--success)">
        <Dot tone="success" />
        Approved version available
      </p>
    );
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <p className="flex gap-2 text-(--ink-muted)">
        <Dot tone="muted" />
        No approved version
      </p>
      <Button
        type="button"
        variant="outline"
        size="xs"
        className="shadow-none"
        disabled
      >
        Install unavailable
      </Button>
    </div>
  );
}

export function UpdateLine({ flagged }: { flagged: boolean }) {
  return flagged ? (
    <p className="flex gap-2 font-semibold text-(--warning)">
      <Dot tone="warning" />
      Update available
    </p>
  ) : (
    <p className="flex gap-2 text-(--ink-muted)">
      <Dot tone="muted" />
      No update flagged
    </p>
  );
}

export function TagButtons({
  tags,
  onTag,
}: {
  tags: string[];
  onTag: (tag: string) => void;
}) {
  if (!tags.length) return null;
  return (
    <ul className="flex min-w-0 flex-wrap gap-1.5">
      {tags.map((tag) => (
        <li key={tag} className="min-w-0 max-w-full">
          <button
            type="button"
            onClick={() => onTag(tag)}
            className="max-w-full rounded-full border border-(--rule) bg-(--paper-raised) px-2.5 py-0.5 text-left text-[13px] leading-[18px] font-medium wrap-anywhere text-(--ink) transition-colors hover:border-(--cobalt) hover:text-(--cobalt)"
          >
            <span className="sr-only">Filter by tag </span>
            {tag}
          </button>
        </li>
      ))}
    </ul>
  );
}

export function SkillTitle({
  skill,
  className,
}: {
  skill: DisplaySkill;
  className?: string;
}) {
  return (
    <Link
      href={skillHref(skill.slug)}
      className={cn(
        "rounded-sm wrap-anywhere text-(--ink-title) underline-offset-4 hover:text-(--cobalt) hover:underline",
        className,
      )}
    >
      {skill.name}
    </Link>
  );
}

// Facts shared by the card and the list row: kind, availability, verdict or alternatives, update flag.
export function SkillFacts({
  skill,
  search,
  showKind = true,
}: {
  skill: DisplaySkill;
  search: boolean;
  showKind?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 text-[13px] leading-[18px] font-medium">
      {showKind && (
        <p className="wrap-anywhere text-(--ink-muted)">{kindLabel(skill)}</p>
      )}
      <Availability skill={skill} />
      {!search && (
        <p className="wrap-anywhere text-(--ink)">
          Quality verdict: {verdictOf(skill.quality)}
        </p>
      )}
      {search && skill.alternatives && skill.alternatives.length > 0 && (
        <p className="wrap-anywhere text-(--ink)">
          Alternatives: {skill.alternatives.join(", ")}
        </p>
      )}
      <UpdateLine flagged={skill.update_available} />
    </div>
  );
}

export function SkillCard({
  skill,
  search,
  onTag,
}: {
  skill: DisplaySkill;
  search: boolean;
  onTag: (tag: string) => void;
}) {
  return (
    <article
      data-component="skill-card"
      className="paper-card flex h-full min-w-0 flex-col gap-3 p-5"
    >
      <div className="flex min-w-0 items-start gap-3">
        <IconTile
          slug={skill.slug}
          kind={skill.kind}
          pluginSlug={skill.plugin_slug}
        />
        <h2 className="min-w-0 pt-1 text-[18px] leading-6 font-semibold">
          <SkillTitle skill={skill} />
        </h2>
      </div>
      <p className="line-clamp-2 text-[15px] leading-6 wrap-anywhere text-(--ink)">
        {skill.description}
      </p>
      <div className="mt-auto flex flex-col gap-3 border-t border-(--rule) pt-3">
        <SkillFacts skill={skill} search={search} />
        <TagButtons tags={skill.tags} onTag={onTag} />
      </div>
    </article>
  );
}
