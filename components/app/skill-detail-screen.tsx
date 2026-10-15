"use client";
import Link from "next/link";
import { useId, useState, type ReactNode } from "react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { IconTile } from "@/components/app/icon-tile";
import { kindLabel } from "@/components/app/skill-card";
import { StatusCard } from "@/components/app/status-card";
import { ReviewHistory, VersionHistory } from "@/components/app/skill-detail-history";
import { UseCard } from "@/components/app/skill-detail-use";
import { usePrivateResource } from "@/components/premium/use-private-resource";
import {
  QualityAssessment,
  RecordedDate,
  ScanFindings,
} from "@/components/premium/review-metadata";
import { safeSourceUrl } from "@/lib/ui/commands.mjs";
import { cn } from "@/lib/utils";
import type {
  ReviewRecord,
  SkillDetailRecord,
  VersionRecord,
} from "@/lib/ui/contracts";

type DetailResponse = { skill: SkillDetailRecord };
type VersionsResponse = { versions: VersionRecord[] };
type ReviewsResponse = { reviews: ReviewRecord[] };
type Resource<T> = ReturnType<typeof usePrivateResource<T>>;

const NOT_RECORDED = "Not recorded";
const INCOMPLETE = "The server returned an incomplete response. Try again.";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// Three independent reads; each retries on its own, and a 403 from any of them,
// or from the archive, hides the whole page.
export function SkillDetailScreen({ slug }: { slug: string }) {
  const base = `/api/skills/${encodeURIComponent(slug)}`;
  const detail = usePrivateResource<DetailResponse>(base);
  const versions = usePrivateResource<VersionsResponse>(`${base}/versions`);
  const reviews = usePrivateResource<ReviewsResponse>(`${base}/reviews`);
  const [archiveForbidden, setArchiveForbidden] = useState(false);

  const forbidden =
    archiveForbidden ||
    [detail, versions, reviews].some((read) => read.error?.status === 403);
  const record =
    detail.state === "success" && object(detail.data?.skill)
      ? detail.data.skill
      : null;

  let content: ReactNode;
  if (forbidden)
    content = (
      <StatusCard
        state="forbidden"
        message="Your account does not have access to this item."
        headingLevel={1}
      />
    );
  else if (detail.state === "error" && detail.error?.status === 404)
    content = (
      <StatusCard
        state="not-found"
        message="This item is not in your library. Check the address or return to the library."
        headingLevel={1}
      />
    );
  else if (detail.state === "error")
    content = (
      <StatusCard
        state="error"
        message={detail.error?.message ?? "Unable to load this content. Try again."}
        onRetry={detail.retry}
        headingLevel={1}
      />
    );
  else if (detail.state === "success" && !record)
    content = (
      <StatusCard
        state="error"
        message={INCOMPLETE}
        onRetry={detail.retry}
        headingLevel={1}
      />
    );
  else if (!record)
    content = (
      <StatusCard state="loading" message="Loading this item…" headingLevel={1} />
    );
  else
    content = (
      <Detail
        record={record}
        versions={versions}
        reviews={reviews}
        onForbidden={() => setArchiveForbidden(true)}
      />
    );

  return (
    <div data-screen="skill-detail" className="@container/detail w-full">
      {content}
    </div>
  );
}

function Detail({
  record,
  versions,
  reviews,
  onForbidden,
}: {
  record: SkillDetailRecord;
  versions: Resource<VersionsResponse>;
  reviews: Resource<ReviewsResponse>;
  onForbidden: () => void;
}) {
  const reviewList =
    reviews.state === "success" && Array.isArray(reviews.data?.reviews)
      ? reviews.data.reviews
      : null;
  return (
    <article
      className={cn(
        "grid max-w-[760px] grid-cols-1 gap-8",
        // Two columns only above 1024 px of content width (spec §6.3).
        "@min-[1024px]/detail:max-w-6xl @min-[1024px]/detail:grid-cols-[minmax(0,1fr)_20rem] @min-[1024px]/detail:gap-x-12",
      )}
    >
      <DetailHeader
        record={record}
        className="@min-[1024px]/detail:col-start-1 @min-[1024px]/detail:row-start-1"
      />
      <UseCard
        record={record}
        onForbidden={onForbidden}
        className="@min-[1024px]/detail:sticky @min-[1024px]/detail:top-6 @min-[1024px]/detail:col-start-2 @min-[1024px]/detail:row-span-2 @min-[1024px]/detail:row-start-1 @min-[1024px]/detail:self-start"
      />
      <div
        className="@container/doc flex min-w-0 max-w-[760px] flex-col gap-10 @min-[1024px]/detail:col-start-1 @min-[1024px]/detail:row-start-2"
      >
        <Provenance record={record} />
        <CurrentReview
          record={record}
          review={
            reviewList?.find((review) => review.current) ??
            reviewList?.[0] ??
            null
          }
        />
        <QualityAndUpdates record={record} />
        <Section title="Version history">
          <History
            resource={versions}
            list={(data) => data.versions}
            loading="Reading the version history…"
            empty="No version history recorded."
            render={(list) => <VersionHistory versions={list} />}
          />
        </Section>
        <Section title="Review history">
          <History
            resource={reviews}
            list={(data) => data.reviews}
            loading="Reading the review history…"
            empty="No review history recorded."
            render={(list) => <ReviewHistory reviews={list} />}
          />
        </Section>
      </div>
    </article>
  );
}

function DetailHeader({
  record,
  className,
}: {
  record: SkillDetailRecord;
  className?: string;
}) {
  return (
    <header className={cn("flex min-w-0 flex-col gap-4", className)}>
      <Breadcrumb>
        <BreadcrumbList className="text-[13px] leading-[18px] font-medium text-(--ink-muted)">
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link
                href="/library"
                className="text-(--cobalt) underline-offset-4 hover:text-(--cobalt-hover) hover:underline"
              >
                Library
              </Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem className="min-w-0">
            <BreadcrumbPage className="wrap-anywhere text-(--ink)">
              {record.name}
            </BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <h1 className="text-[30px] leading-9 font-extrabold tracking-[-0.02em] wrap-anywhere text-(--ink-title) @2xl/detail:text-[40px] @2xl/detail:leading-[44px]">
        {record.name}
      </h1>
      <div className="flex min-w-0 items-center gap-3">
        <IconTile
          slug={record.slug}
          kind={record.kind}
          pluginSlug={record.plugin_slug}
        />
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-[15px] leading-6">
          <span className="font-semibold wrap-anywhere text-(--ink-title)">
            {kindLabel(record)}
          </span>
          <span aria-hidden="true" className="text-(--ink-muted)">
            ·
          </span>
          <span className="min-w-0 font-mono text-[13px] wrap-anywhere text-(--ink-muted)">
            {record.slug}
          </span>
        </p>
      </div>
      {record.description && (
        <p className="max-w-[68ch] text-[15px] leading-6 wrap-anywhere text-(--ink)">
          {record.description}
        </p>
      )}
      {record.tags.length ? (
        <ul aria-label="Tags" className="flex min-w-0 flex-wrap gap-1.5">
          {record.tags.map((tag) => (
            <li
              key={tag}
              className="max-w-full rounded-full border border-(--rule) bg-(--paper-raised) px-2.5 py-0.5 text-[13px] leading-[18px] font-medium wrap-anywhere text-(--ink)"
            >
              {tag}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] leading-[18px] font-medium text-(--ink-muted)">
          No tags recorded
        </p>
      )}
    </header>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className="flex min-w-0 flex-col gap-4 border-t border-(--rule) pt-8"
    >
      <h2
        id={id}
        className="text-[22px] leading-7 font-bold tracking-[-0.01em] text-(--ink-title)"
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

// Two-column definition grid; stacked below 28rem of document width.
function Fields({ children }: { children: ReactNode }) {
  return <dl className="flex min-w-0 flex-col gap-3">{children}</dl>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-1 @md/doc:grid-cols-[11rem_minmax(0,1fr)] @md/doc:gap-6">
      <dt className="text-[13px] leading-[22px] font-semibold text-(--ink-muted)">
        {label}
      </dt>
      <dd className="min-w-0 text-[15px] leading-[22px] wrap-anywhere text-(--ink)">
        {children}
      </dd>
    </div>
  );
}

function Mono({ value }: { value: string | null }) {
  if (value === null || value === "") return <>{NOT_RECORDED}</>;
  return (
    <span className="font-mono text-[13px] break-all select-text">{value}</span>
  );
}

function Provenance({ record }: { record: SkillDetailRecord }) {
  const href = safeSourceUrl(record.source_url);
  return (
    <Section title="Provenance">
      <Fields>
        <Field label="Kind">{kindLabel(record)}</Field>
        <Field label="Source kind">{record.source_kind || NOT_RECORDED}</Field>
        <Field label="Source URL">
          {href ? (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-(--cobalt) underline underline-offset-4 hover:text-(--cobalt-hover)"
            >
              {record.source_url}
            </a>
          ) : (
            record.source_url || NOT_RECORDED
          )}
        </Field>
        <Field label="Default reference">
          {record.default_ref || NOT_RECORDED}
        </Field>
        <Field label="Source path">{record.source_path || NOT_RECORDED}</Field>
        <Field label="Commit">
          <Mono value={record.commit_sha} />
        </Field>
        <Field label="Content SHA-256">
          <Mono value={record.sha256} />
        </Field>
        <Field label="Archive size">
          {record.size === null
            ? NOT_RECORDED
            : `${record.size} ${record.size === 1 ? "byte" : "bytes"}`}
        </Field>
      </Fields>
    </Section>
  );
}

function Dot({ tone }: { tone: "success" | "warning" | "muted" }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "mt-[7px] size-2 shrink-0 rounded-full",
        tone === "success" && "bg-(--success)",
        tone === "warning" && "bg-(--warning)",
        tone === "muted" && "border border-(--ink-muted)",
      )}
    />
  );
}

function CurrentReview({
  record,
  review,
}: {
  record: SkillDetailRecord;
  // The current version's review; the newest one only when none is current.
  review: ReviewRecord | null;
}) {
  const approved = record.sha256 !== null;
  return (
    <Section title="Current review">
      <p
        className={cn(
          "flex gap-2 text-[15px] leading-6 font-semibold",
          approved ? "text-(--success)" : "text-(--ink-muted)",
        )}
      >
        <Dot tone={approved ? "success" : "muted"} />
        {approved ? "Approved current version" : "No approved version"}
      </p>
      <Fields>
        {review && (
          <Field label="Review status">
            <span className="font-semibold">{review.status}</span>
          </Field>
        )}
        <Field label="Reviewed at">
          <RecordedDate value={record.reviewed_at} />
        </Field>
        <Field label="Review notes">
          <span className="whitespace-pre-wrap">
            {record.review_notes || NOT_RECORDED}
          </span>
        </Field>
      </Fields>
      <div className="flex min-w-0 flex-col gap-2">
        <h3 className="text-[15px] leading-6 font-semibold text-(--ink-title)">
          Scan findings
        </h3>
        <div className="min-w-0 text-[14px] leading-[22px] text-(--ink)">
          <ScanFindings flags={record.scan_flags} />
        </div>
      </div>
    </Section>
  );
}

function QualityAndUpdates({ record }: { record: SkillDetailRecord }) {
  return (
    <Section title="Quality and updates">
      <div className="min-w-0 text-[14px] leading-[22px] text-(--ink)">
        <QualityAssessment quality={record.quality} />
      </div>
      <p
        className={cn(
          "flex gap-2 text-[15px] leading-6 font-semibold",
          record.update_available ? "text-(--warning)" : "text-(--ink-muted)",
        )}
      >
        <Dot tone={record.update_available ? "warning" : "muted"} />
        {record.update_available
          ? "Upstream change detected. This does not confirm a change to this item."
          : "No upstream change detected."}
      </p>
      <Fields>
        <Field label="Latest upstream commit">
          <Mono value={record.latest_commit} />
        </Field>
      </Fields>
    </Section>
  );
}

// One history region: its own loading, retry and empty states.
function History<T, R>({
  resource,
  list,
  loading,
  empty,
  render,
}: {
  resource: Resource<T>;
  list: (data: T) => R[];
  loading: string;
  empty: string;
  render: (rows: R[]) => ReactNode;
}) {
  if (resource.state === "error")
    return (
      <StatusCard
        state="error"
        message={resource.error?.message ?? "Unable to load this content. Try again."}
        onRetry={resource.retry}
      />
    );
  if (resource.state !== "success" || !resource.data)
    return <StatusCard state="loading" message={loading} />;
  const rows: unknown = object(resource.data) ? list(resource.data) : null;
  if (!Array.isArray(rows))
    return (
      <StatusCard state="error" message={INCOMPLETE} onRetry={resource.retry} />
    );
  if (!rows.length)
    return <p className="text-[15px] leading-6 text-(--ink-muted)">{empty}</p>;
  return render(rows as R[]);
}
