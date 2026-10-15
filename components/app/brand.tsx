import Link from "next/link";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

type BrandProps = Omit<ComponentProps<typeof Link>, "href" | "children">;

// Home link whose accessible name is exactly "Headjack": the mark is decorative (alt=""), and the live text carries the
// name in the site's heading font and color (extrabold Manrope, --ink-title). The mark is a static SVG from
// public/brand, so a plain <img> keeps it unprocessed.
export function Brand({ className, ...props }: BrandProps) {
  return (
    <Link
      href="/"
      className={cn(
        "inline-flex w-fit items-center gap-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-(--cobalt) focus-visible:ring-offset-2 focus-visible:ring-offset-(--paper-raised)",
        className,
      )}
      {...props}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/mark.svg" alt="" width={24} height={24} className="size-6 shrink-0" />
      <span className="h-5 text-xl leading-5 font-extrabold tracking-[-0.02em] text-(--ink-title)">Headjack</span>
    </Link>
  );
}
