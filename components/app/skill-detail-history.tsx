import type { ReactNode } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  RecordedDate,
  ScanFindings,
} from "@/components/premium/review-metadata";
import type { ReviewRecord, VersionRecord } from "@/lib/ui/contracts";

// Ruled history tables. Below 36rem of document width each row stacks into
// labelled blocks, so nothing scrolls sideways (spec §6.3, Appendix A).
const STACKED = "@max-xl/doc:block";
const HEAD =
  "h-10 px-3 align-bottom text-[13px] leading-[18px] font-semibold whitespace-normal text-(--ink-muted) first:pl-0";
const CELL =
  "min-w-0 px-3 py-3.5 align-top text-[14px] leading-[22px] whitespace-normal wrap-anywhere text-(--ink) first:pl-0 @max-xl/doc:px-0 @max-xl/doc:py-1.5";
const ROW =
  "border-(--rule) hover:bg-transparent @max-xl/doc:block @max-xl/doc:py-3";

// Visible only when stacked; the header row still names each cell for assistive tech.
function CellLabel({ children }: { children: ReactNode }) {
  return (
    <span
      aria-hidden="true"
      className="hidden text-[13px] leading-[18px] font-semibold text-(--ink-muted) @max-xl/doc:block"
    >
      {children}
    </span>
  );
}

function HistoryTable({
  label,
  columns,
  children,
}: {
  label: string;
  columns: { name: string; width: string }[];
  children: ReactNode;
}) {
  return (
    <Table aria-label={label} className={`table-fixed text-(--ink) ${STACKED}`}>
      <TableHeader className="@max-xl/doc:sr-only">
        <TableRow className="border-(--rule) hover:bg-transparent">
          {columns.map((column) => (
            <TableHead key={column.name} className={`${HEAD} ${column.width}`}>
              {column.name}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody className={STACKED}>{children}</TableBody>
    </Table>
  );
}

// One summary per version row (spec §8): four or more findings keep
// ScanFindings' own disclosure; fewer are wrapped in one here.
function VersionFindings({ flags }: { flags: unknown[] | null }) {
  if (flags && flags.length > 3) return <ScanFindings flags={flags} />;
  const summary = !flags
    ? "Scan findings not recorded"
    : !flags.length
      ? "No scan findings"
      : `${flags.length} scan ${flags.length === 1 ? "finding" : "findings"}`;
  return (
    <details className="metadata-disclosure">
      <summary>{summary}</summary>
      <ScanFindings flags={flags} />
    </details>
  );
}

export function VersionHistory({ versions }: { versions: VersionRecord[] }) {
  return (
    <HistoryTable
      label="Recorded versions"
      columns={[
        { name: "Reviewed at", width: "w-[22%]" },
        { name: "Status", width: "w-[13%]" },
        { name: "Content hash", width: "w-[27%]" },
        { name: "Scan findings", width: "w-[38%]" },
      ]}
    >
      {versions.map((version, index) => (
        <TableRow key={`${version.id}:${index}`} className={ROW}>
          <TableCell className={`${CELL} ${STACKED}`}>
            <CellLabel>Reviewed at</CellLabel>
            <RecordedDate value={version.reviewed_at} />
          </TableCell>
          <TableCell className={`${CELL} ${STACKED}`}>
            <CellLabel>Status</CellLabel>
            <span className="font-semibold">{version.status}</span>
          </TableCell>
          <TableCell className={`${CELL} ${STACKED}`}>
            <CellLabel>Content hash</CellLabel>
            <code className="font-mono text-[13px] leading-5 break-all select-text">
              {version.sha256}
            </code>
          </TableCell>
          <TableCell className={`${CELL} ${STACKED}`}>
            <CellLabel>Scan findings</CellLabel>
            <div className="min-w-0">
              <VersionFindings flags={version.scan_flags} />
            </div>
          </TableCell>
        </TableRow>
      ))}
    </HistoryTable>
  );
}

export function ReviewHistory({ reviews }: { reviews: ReviewRecord[] }) {
  return (
    <HistoryTable
      label="Recorded reviews"
      columns={[
        { name: "Reviewed at", width: "w-[30%]" },
        { name: "Status", width: "w-[16%]" },
        { name: "Notes", width: "w-[54%]" },
      ]}
    >
      {reviews.map((review, index) => (
        <TableRow key={`${review.sha256}:${index}`} className={ROW}>
          <TableCell className={`${CELL} ${STACKED}`}>
            <CellLabel>Reviewed at</CellLabel>
            <RecordedDate value={review.reviewed_at} />
          </TableCell>
          <TableCell className={`${CELL} ${STACKED}`}>
            <CellLabel>Status</CellLabel>
            <span className="font-semibold">{review.status}</span>
          </TableCell>
          <TableCell className={`${CELL} ${STACKED}`}>
            <CellLabel>Notes</CellLabel>
            <span className="whitespace-pre-wrap">
              {review.review_notes ?? "Not recorded"}
            </span>
          </TableCell>
        </TableRow>
      ))}
    </HistoryTable>
  );
}
