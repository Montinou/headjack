import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

// Browse pagination: range text plus previous/next, right-aligned under the results.
export function Pagination({
  offset,
  total,
  limit,
  onPage,
}: {
  offset: number;
  total: number;
  limit: number;
  onPage: (offset: number) => void;
}) {
  const first = total === 0 ? 0 : offset + 1;
  const last = Math.min(offset + limit, total);
  return (
    <nav
      aria-label="Library pages"
      className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2"
    >
      <p className="text-[13px] leading-[18px] font-medium text-(--ink-muted)">
        Showing {first}–{last} of {total} · {limit} per page
      </p>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shadow-none"
          disabled={offset === 0}
          onClick={() => onPage(Math.max(0, offset - limit))}
        >
          <ChevronLeft aria-hidden="true" />
          Previous page
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shadow-none"
          disabled={offset + limit >= total}
          onClick={() => onPage(offset + limit)}
        >
          Next page
          <ChevronRight aria-hidden="true" />
        </Button>
      </div>
    </nav>
  );
}
