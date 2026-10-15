import { BookOpen, Layers, Puzzle } from "lucide-react";
import { iconForKind, tintForSlug } from "@/lib/ui/icon-tile.mjs";

const ICONS = { book: BookOpen, puzzle: Puzzle, layers: Layers } as const;

export function IconTile({
  slug,
  kind,
  pluginSlug,
}: {
  slug: string;
  kind: "skill" | "plugin";
  pluginSlug: string | null;
}) {
  const Icon = ICONS[iconForKind(kind, pluginSlug)];
  return (
    <span className="icon-tile" data-tint={tintForSlug(slug)} aria-hidden="true">
      <Icon strokeWidth={2} />
    </span>
  );
}
