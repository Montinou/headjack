"use client";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { LayoutGrid, List, Plus, Search, X, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { StatusCard } from "@/components/app/status-card";
import { SkillCard } from "@/components/app/skill-card";
import { SkillTable } from "@/components/app/skill-table";
import { Pagination } from "@/components/app/pagination";
import { usePrivateResource } from "@/components/premium/use-private-resource";
import {
  BROWSE_LIMIT,
  SEARCH_LIMIT,
  changeCatalogState,
  parseCatalogState,
  serializeCatalogState,
} from "@/lib/ui/catalog-state.mjs";
import { MAX_TAGS, normalizeTag } from "@/lib/tags.mjs";
import type {
  CatalogResponse,
  CatalogSkill,
  CatalogState,
  DisplaySkill,
  SearchResponse,
  SearchSkill,
} from "@/lib/ui/contracts";

const DEFAULT_STATE: CatalogState = {
  q: "",
  kind: null,
  tags: [],
  view: "grid",
  offset: 0,
};

function readState(params: Pick<URLSearchParams, "get" | "getAll">) {
  try {
    return { state: parseCatalogState(params) as CatalogState, invalid: null };
  } catch (error) {
    return {
      state: null,
      invalid:
        error instanceof Error ? error.message : "This library address is invalid.",
    };
  }
}

// Search sends k=25 and no offset; browse pages 24 at a time.
function resourcePath(state: CatalogState) {
  const query = new URLSearchParams();
  if (state.q) {
    query.set("q", state.q);
    query.set("k", String(SEARCH_LIMIT));
  } else {
    query.set("limit", String(BROWSE_LIMIT));
    query.set("offset", String(state.offset));
  }
  if (state.kind) query.set("kind", state.kind);
  for (const tag of state.tags) query.append("tag", tag);
  return `${state.q ? "/api/search" : "/api/skills"}?${query}`;
}

const fromCatalog = ({
  has_approved_version,
  ...skill
}: CatalogSkill): DisplaySkill => ({ ...skill, approved: has_approved_version });

// Search answers only approved items, so every result is shown as available.
const fromSearch = (skill: SearchSkill): DisplaySkill => ({
  slug: skill.slug,
  name: skill.name,
  description: skill.description,
  kind: skill.kind,
  plugin_slug: skill.plugin_slug,
  tags: skill.tags,
  update_available: skill.update_available,
  approved: true,
  quality: null,
  alternatives: skill.alternatives,
});

export function LibraryScreen() {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const { state, invalid } = readState(params);
  const current = state ?? DEFAULT_STATE;
  const resource = usePrivateResource<CatalogResponse | SearchResponse>(
    state ? resourcePath(state) : null,
  );
  const [tagNote, setTagNote] = useState("");
  // Unsubmitted drafts: the tag draft lives here and the search draft is remounted by key, so "Reset filters"
  // clears both even when the URL is already default and nothing navigates.
  const [tagDraft, setTagDraft] = useState("");
  const [resetCount, setResetCount] = useState(0);

  const go = (next: CatalogState) => {
    const query = serializeCatalogState(next).toString();
    router.push(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };
  const change = (patch: Partial<CatalogState>) =>
    go(changeCatalogState(current, patch) as CatalogState);
  const addTag = (raw: string) => {
    const tag = normalizeTag(raw);
    if (!tag) {
      setTagNote("Use letters or digits in a tag.");
      return false;
    }
    setTagNote("");
    if (current.tags.includes(tag)) return true;
    if (current.tags.length >= MAX_TAGS) {
      setTagNote(`Use at most ${MAX_TAGS} tags.`);
      return false;
    }
    change({ tags: [...current.tags, tag] });
    return true;
  };
  const reset = () => {
    setTagNote("");
    setTagDraft("");
    setResetCount((count) => count + 1);
    go({ ...DEFAULT_STATE, view: current.view });
  };

  const searching = Boolean(current.q);
  const data = resource.state === "success" ? resource.data : null;
  const skills: DisplaySkill[] | null = data
    ? "results" in data
      ? data.results.map(fromSearch)
      : data.skills.map(fromCatalog)
    : null;
  const total = data && "total" in data ? data.total : 0;
  const count = !data
    ? ""
    : searching
      ? `Up to ${SEARCH_LIMIT} matching skills`
      : `${total} ${total === 1 ? "skill" : "skills"} in this view`;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-[30px] leading-9 font-extrabold tracking-[-0.02em] text-(--ink-title) @2xl:text-[40px] @2xl:leading-[44px]">
          Your private library
        </h1>
        <p className="max-w-2xl text-[15px] leading-6 text-(--ink-muted)">
          Browse, search and filter every skill and plugin in your vault.
        </p>
      </header>
      <SearchBar key={resetCount} query={current.q} onSearch={(q) => change({ q })} />
      <FilterRow
        state={current}
        note={tagNote}
        tag={tagDraft}
        onTag={setTagDraft}
        onKind={(kind) => change({ kind })}
        onAddTag={addTag}
        onRemoveTag={(tag) =>
          change({ tags: current.tags.filter((item) => item !== tag) })
        }
        onReset={reset}
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p
          role="status"
          className="text-[15px] leading-6 font-semibold text-(--ink-title)"
        >
          {count}
        </p>
        <div
          role="group"
          aria-label="Library view"
          className="flex gap-1 rounded-lg border border-(--rule) bg-(--paper-raised) p-1"
        >
          <ViewButton
            icon={LayoutGrid}
            label="Grid"
            pressed={current.view === "grid"}
            onClick={() => current.view !== "grid" && change({ view: "grid" })}
          />
          <ViewButton
            icon={List}
            label="List"
            pressed={current.view === "list"}
            onClick={() => current.view !== "list" && change({ view: "list" })}
          />
        </div>
      </div>
      {invalid !== null ? (
        <StatusCard state="error" message={invalid} />
      ) : resource.state === "error" ? (
        <StatusCard
          state="error"
          message={
            resource.error?.message ?? "Unable to load this content. Try again."
          }
          onRetry={resource.retry}
        />
      ) : !skills ? (
        <StatusCard state="loading" message="Reading your skills…" />
      ) : skills.length === 0 ? (
        <StatusCard state="empty" message={emptyMessage(current)} />
      ) : (
        <Results>
          {current.view === "list" ? (
            <SkillTable
              skills={skills}
              search={searching}
              onTag={(tag) => void addTag(tag)}
            />
          ) : (
            <ul className="grid grid-cols-1 gap-4 @min-[600px]:grid-cols-2 @min-[960px]:grid-cols-3">
              {skills.map((skill) => (
                <li key={skill.slug} className="min-w-0">
                  <SkillCard
                    skill={skill}
                    search={searching}
                    onTag={(tag) => void addTag(tag)}
                  />
                </li>
              ))}
            </ul>
          )}
          {!searching && (
            <Pagination
              offset={current.offset}
              total={total}
              limit={BROWSE_LIMIT}
              onPage={(offset) => change({ offset })}
            />
          )}
        </Results>
      )}
    </div>
  );
}

function emptyMessage(state: CatalogState) {
  if (!state.q && state.offset > 0)
    return "No skills on this page. Reset filters to return to the first page.";
  if (state.q || state.kind || state.tags.length)
    return "No skills match these filters.";
  return "Your vault is empty. Add a skill with the CLI to begin.";
}

function Results({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-5">{children}</div>;
}

// Submit-only search: typing never reads; Enter or the button does, and focus stays in the field.
function SearchBar({
  query,
  onSearch,
}: {
  query: string;
  onSearch: (q: string) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(query);
  const [shown, setShown] = useState(query);
  if (shown !== query) {
    setShown(query);
    setDraft(query);
  }
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSearch(draft.trim());
  };
  return (
    <form role="search" onSubmit={submit} className="flex gap-2">
      <label htmlFor={id} className="sr-only">
        Search skills
      </label>
      <div className="relative min-w-0 flex-1">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-3.5 size-[18px] -translate-y-1/2 text-(--ink-muted)"
        />
        <Input
          id={id}
          type="search"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Search your skills"
          className="h-11 rounded-lg bg-(--paper-raised) pl-10 text-[15px] text-(--ink) shadow-none md:text-[15px]"
        />
      </div>
      <Button type="submit" className="h-11 px-5">
        Search
      </Button>
    </form>
  );
}

function FilterRow({
  state,
  note,
  tag,
  onTag,
  onKind,
  onAddTag,
  onRemoveTag,
  onReset,
}: {
  state: CatalogState;
  note: string;
  tag: string;
  onTag: (tag: string) => void;
  onKind: (kind: CatalogState["kind"]) => void;
  onAddTag: (tag: string) => boolean;
  onRemoveTag: (tag: string) => void;
  onReset: () => void;
}) {
  const kindId = useId();
  const tagId = useId();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (onAddTag(tag)) onTag("");
  };
  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="flex items-center gap-2">
          <label
            htmlFor={kindId}
            className="text-[13px] leading-[18px] font-semibold text-(--ink-muted)"
          >
            Kind
          </label>
          <select
            id={kindId}
            value={state.kind ?? ""}
            onChange={(event) =>
              onKind(
                event.target.value === "skill" || event.target.value === "plugin"
                  ? event.target.value
                  : null,
              )
            }
            className="h-9 rounded-md border border-input bg-(--paper-raised) px-2.5 text-[15px] text-(--ink)"
          >
            <option value="">All kinds</option>
            <option value="skill">Skills</option>
            <option value="plugin">Plugins</option>
          </select>
        </div>
        <form onSubmit={submit} className="flex min-w-0 items-center gap-2">
          <label htmlFor={tagId} className="sr-only">
            Add tag
          </label>
          <Input
            id={tagId}
            value={tag}
            onChange={(event) => onTag(event.target.value)}
            placeholder="Tag, e.g. front-end"
            className="h-9 w-44 min-w-0 bg-(--paper-raised) text-[15px] text-(--ink) shadow-none md:text-[15px]"
          />
          <Button type="submit" variant="outline" className="shadow-none">
            <Plus aria-hidden="true" />
            Add tag
          </Button>
        </form>
        {state.tags.length > 0 && (
          <ul aria-label="Active tags" className="flex min-w-0 flex-wrap gap-2">
            {state.tags.map((item) => (
              <li key={item} className="min-w-0 max-w-full">
                <button
                  type="button"
                  onClick={() => onRemoveTag(item)}
                  className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-(--cobalt-soft) py-1 pr-2 pl-3 text-left text-[13px] leading-[18px] font-semibold wrap-anywhere text-(--cobalt) hover:text-(--cobalt-hover)"
                >
                  <span className="sr-only">Remove tag </span>
                  <span className="min-w-0">{item}</span>
                  <X aria-hidden="true" className="size-3.5 shrink-0" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <Button
          type="button"
          variant="ghost"
          onClick={onReset}
          className="px-2.5 text-(--cobalt) hover:bg-(--cobalt-soft) hover:text-(--cobalt-hover)"
        >
          Reset filters
        </Button>
      </div>
      <p
        aria-live="polite"
        className={cn("text-[13px] leading-[18px] text-(--danger)", note && "mt-2")}
      >
        {note}
      </p>
    </div>
  );
}

function ViewButton({
  icon: Icon,
  label,
  pressed,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  pressed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className="inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[13px] leading-[18px] font-semibold text-(--ink-muted) transition-colors hover:text-(--ink-title) aria-pressed:bg-(--cobalt-soft) aria-pressed:text-(--cobalt)"
    >
      <Icon aria-hidden="true" className="size-4" />
      {label}
      <span className="sr-only"> view</span>
    </button>
  );
}
