"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyCommand } from "@/components/app/copy-command";
import { skillHref } from "@/components/app/skill-card";
import { PRIVATE_SESSION_EXPIRED_EVENT } from "@/lib/ui/api";
import { skillAddCommand } from "@/lib/ui/commands.mjs";
import { cn } from "@/lib/utils";
import type { SkillDetailRecord } from "@/lib/ui/contracts";

type Archive =
  | { state: "idle" | "pending" | "unavailable" | "failed" }
  | { state: "done"; sha256: string };

// Slug with every non-alphanumeric character replaced by "_" (Appendix A).
export const archiveFilename = (slug: string) =>
  `${slug.replace(/[^A-Za-z0-9]/g, "_")}.tar.gz`;

function archiveStatus(archive: Archive) {
  switch (archive.state) {
    case "pending":
      return "Downloading the archive…";
    case "done":
      return `Archive downloaded. Content SHA-256: ${archive.sha256}`;
    case "unavailable":
      return "Archive unavailable. No approved archive could be read for this item. Try again later.";
    case "failed":
      return "Unable to download the archive. Try again.";
    default:
      return "";
  }
}

// Side card: install command and archive. Approval is a non-null content SHA-256.
// Unmounting (session change, or any 403 hiding the page) aborts a pending archive,
// and a response that arrives after the abort is ignored.
export function UseCard({
  record,
  onForbidden,
  className,
}: {
  record: SkillDetailRecord;
  onForbidden: () => void;
  className?: string;
}) {
  const approved = record.sha256 !== null;
  const plugin = record.kind === "plugin";
  const contained = !plugin && record.plugin_slug !== null;
  const downloadable = approved && !plugin && !contained;
  const [archive, setArchive] = useState<Archive>({ state: "idle" });
  const pending = useRef<AbortController | null>(null);

  useEffect(() => () => pending.current?.abort(), []);

  async function download() {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    const live = () => !controller.signal.aborted;
    setArchive({ state: "pending" });
    let response: Response;
    try {
      response = await fetch(
        `/api/skills/${encodeURIComponent(record.slug)}/download`,
        {
          signal: controller.signal,
          credentials: "same-origin",
          cache: "no-store",
        },
      );
    } catch {
      if (live()) setArchive({ state: "failed" });
      return;
    }
    if (!live()) return;
    if (response.status === 401) {
      window.dispatchEvent(new Event(PRIVATE_SESSION_EXPIRED_EVENT));
      return;
    }
    if (response.status === 403) {
      controller.abort();
      onForbidden();
      return;
    }
    if (response.status === 404 || response.status === 409) {
      setArchive({ state: "unavailable" });
      return;
    }
    if (!response.ok) {
      setArchive({ state: "failed" });
      return;
    }
    let blob: Blob;
    try {
      blob = await response.blob();
    } catch {
      if (live()) setArchive({ state: "failed" });
      return;
    }
    if (!live()) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = archiveFilename(record.slug);
    document.body.append(link);
    link.click();
    link.remove();
    // Revoke after the click has handed the blob to the download.
    setTimeout(() => URL.revokeObjectURL(url), 0);
    setArchive({
      state: "done",
      sha256: response.headers.get("x-skill-sha256") ?? record.sha256 ?? "",
    });
  }

  return (
    <section
      aria-label="CLI and archive"
      className={cn("paper-card flex min-w-0 flex-col gap-5 p-5", className)}
    >
      <h2 className="text-[22px] leading-7 font-bold tracking-[-0.01em] text-(--ink-title)">
        {plugin ? "Use this plugin" : "Use this skill"}
      </h2>
      <div className="flex min-w-0 flex-col gap-2">
        <h3 className="text-[15px] leading-6 font-semibold text-(--ink-title)">
          Install
        </h3>
        <p className="text-[13px] leading-[18px] font-medium text-(--ink-muted)">
          {approved
            ? "Add it with the Headjack CLI."
            : "No approved version is available to install."}
        </p>
        <CopyCommand
          command={approved ? skillAddCommand(record.slug) : null}
          className="[&>code]:w-full"
        />
      </div>
      <div className="flex min-w-0 flex-col gap-2 border-t border-(--rule) pt-5">
        <h3 className="text-[15px] leading-6 font-semibold text-(--ink-title)">
          Archive
        </h3>
        <Button
          type="button"
          variant="outline"
          className="self-start shadow-none"
          disabled={!downloadable || archive.state === "pending"}
          onClick={() => void download()}
        >
          <Download aria-hidden="true" />
          Download archive
        </Button>
        <p className="text-[13px] leading-[18px] font-medium wrap-anywhere text-(--ink-muted)">
          {plugin ? (
            "Plugins are not offered as archives: adding one with the CLI enables the plugin in Claude settings."
          ) : contained ? (
            <>
              This skill ships in the plugin{" "}
              <Link
                href={skillHref(record.plugin_slug ?? "")}
                className="font-semibold text-(--cobalt) underline underline-offset-4 hover:text-(--cobalt-hover)"
              >
                {record.plugin_slug}
              </Link>
              . Adding it with the CLI enables the plugin in Claude settings, so
              no archive is offered.
            </>
          ) : approved ? (
            "Downloading the archive does not install it. Use the install command to add the skill."
          ) : (
            "No approved archive is available."
          )}
        </p>
        <p
          role="status"
          className="text-[13px] leading-[18px] font-medium wrap-anywhere text-(--ink)"
        >
          {archiveStatus(archive)}
        </p>
      </div>
    </section>
  );
}
