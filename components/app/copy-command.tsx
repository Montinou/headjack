"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { copyButtonText } from "@/lib/ui/copy-command.mjs";

const COPIED = "Command copied.";
const UNAVAILABLE = "Clipboard unavailable. Select the command and copy it manually.";

export function CopyCommand({
  command,
  label,
  disabled = false,
  className,
}: {
  command: string | null;
  label?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [status, setStatus] = useState("");
  const text = copyButtonText(label);

  async function copy() {
    if (command === null) return;
    try {
      await navigator.clipboard.writeText(command);
      setStatus(COPIED);
    } catch {
      setStatus(UNAVAILABLE);
    }
  }

  return (
    <div className={cn("flex flex-col items-start gap-2", className)}>
      {command !== null && <code className="mono-box select-text">{command}</code>}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="shadow-none"
        disabled={disabled || command === null}
        aria-label={text.name}
        onClick={copy}
      >
        {text.visible}
      </Button>
      <p role="status" className="text-sm text-muted-foreground">
        {status}
      </p>
    </div>
  );
}
