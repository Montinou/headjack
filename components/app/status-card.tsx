import {
  FileSearch,
  Inbox,
  LoaderCircle,
  LockKeyhole,
  ShieldOff,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type StatusState =
  | "loading"
  | "empty"
  | "error"
  | "unauthorized"
  | "forbidden"
  | "not-found";

const HEADINGS: Record<StatusState, string> = {
  loading: "Loading your library",
  empty: "Nothing here yet",
  error: "Unable to load this content",
  unauthorized: "Sign in to continue",
  forbidden: "Access unavailable",
  "not-found": "Content not found",
};

const ICONS: Record<StatusState, LucideIcon> = {
  loading: LoaderCircle,
  empty: Inbox,
  error: TriangleAlert,
  unauthorized: LockKeyhole,
  forbidden: ShieldOff,
  "not-found": FileSearch,
};

// Every loading, empty, error and session state renders through this card.
// headingLevel 1 only when the card is the sole content of `main`.
export function StatusCard({
  state,
  message,
  onRetry,
  headingLevel = 2,
}: {
  state: StatusState;
  message: string;
  onRetry?: () => void;
  headingLevel?: 1 | 2;
}) {
  const Heading = headingLevel === 1 ? "h1" : "h2";
  const Icon = ICONS[state];
  const error = state === "error";
  return (
    <div
      data-component="status-card"
      data-state={state}
      role={error ? "alert" : "status"}
      aria-busy={state === "loading" ? true : undefined}
      className="paper-card mx-auto my-10 flex w-[min(calc(100%-2rem),28rem)] flex-col items-center gap-3 px-6 py-8 text-center"
    >
      <span
        aria-hidden="true"
        className={cn(
          "flex size-11 items-center justify-center rounded-full bg-(--cobalt-soft)",
          error ? "text-(--danger)" : "text-(--cobalt)",
        )}
      >
        <Icon
          className={cn(
            "size-5",
            state === "loading" && "motion-safe:animate-spin",
          )}
          strokeWidth={2}
        />
      </span>
      <Heading className="text-[22px] leading-7 font-bold tracking-[-0.01em] text-(--ink-title)">
        {HEADINGS[state]}
      </Heading>
      <p className="max-w-prose text-[15px] leading-6 text-(--ink-muted)">
        {message}
      </p>
      {onRetry && (
        <Button
          type="button"
          variant="outline"
          className="mt-1 shadow-none"
          onClick={onRetry}
        >
          Try again
        </Button>
      )}
    </div>
  );
}
