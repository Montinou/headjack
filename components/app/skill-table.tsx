import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { IconTile } from "@/components/app/icon-tile";
import {
  kindLabel,
  SkillFacts,
  SkillTitle,
  TagButtons,
} from "@/components/app/skill-card";
import type { DisplaySkill } from "@/lib/ui/contracts";

const HEAD =
  "h-11 px-4 text-[13px] leading-[18px] font-semibold text-(--ink-muted)";
const CELL = "px-4 py-4 align-top whitespace-normal";

// List view: ruled rows with the icon tile in the Skill column.
// Below 36rem of width the table scrolls inside its own container, never the page.
export function SkillTable({
  skills,
  search,
  onTag,
}: {
  skills: DisplaySkill[];
  search: boolean;
  onTag: (tag: string) => void;
}) {
  return (
    <div className="paper-card overflow-hidden p-0">
      <Table aria-label="Library skills" className="min-w-[36rem] text-(--ink)">
        <TableHeader>
          <TableRow className="border-(--rule) hover:bg-transparent">
            <TableHead className={HEAD}>Skill</TableHead>
            <TableHead className={HEAD}>Availability and updates</TableHead>
            <TableHead className={HEAD}>Tags</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {skills.map((skill) => (
            <TableRow
              key={skill.slug}
              className="border-(--rule) hover:bg-(--paper)"
            >
              <TableCell className={`${CELL} w-[44%] min-w-0`}>
                <div className="flex min-w-0 items-start gap-3">
                  <IconTile
                    slug={skill.slug}
                    kind={skill.kind}
                    pluginSlug={skill.plugin_slug}
                  />
                  <div className="flex min-w-0 flex-col gap-1">
                    <SkillTitle
                      skill={skill}
                      className="text-[15px] leading-6 font-semibold"
                    />
                    <p className="text-[13px] leading-[18px] font-medium wrap-anywhere text-(--ink-muted)">
                      {kindLabel(skill)}
                    </p>
                    <p className="line-clamp-2 text-[13px] leading-[18px] wrap-anywhere text-(--ink)">
                      {skill.description}
                    </p>
                  </div>
                </div>
              </TableCell>
              <TableCell className={CELL}>
                <SkillFacts skill={skill} search={search} showKind={false} />
              </TableCell>
              <TableCell className={`${CELL} w-[26%]`}>
                {skill.tags.length ? (
                  <TagButtons tags={skill.tags} onTag={onTag} />
                ) : (
                  <span className="text-[13px] text-(--ink-muted)">
                    No tags
                  </span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
