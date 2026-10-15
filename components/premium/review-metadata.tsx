import type { ReactNode } from "react";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// Stable English UTC presentation preserves the complete original timestamp.
export function RecordedDate({ value }: { value: unknown }) {
  if (typeof value !== "string" || !value)
    return <RecordedValue value={value} />;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return <>{value}</>;
  const label = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(date);
  return <time dateTime={value} title={value}>{label}</time>;
}

function RecordedValue({ value }: { value: unknown }): ReactNode {
  if (value === null || value === undefined || value === "") return "Not recorded";
  if (Array.isArray(value))
    return value.length ? (
      <ol className="metadata-values">
        {value.map((item, i) => <li key={i}><RecordedValue value={item} /></li>)}
      </ol>
    ) : "No entries recorded";
  if (object(value))
    return (
      <dl className="metadata-fields">
        {Object.entries(value).map(([key, item]) => (
          <MetadataField key={key} label={key} value={item} />
        ))}
      </dl>
    );
  return String(value);
}

function MetadataField({
  label,
  value,
  date = false,
}: {
  label: string;
  value: unknown;
  date?: boolean;
}) {
  // Wrapper classes let the quality row size numbers, text and the date apart.
  const kind = date ? "metadata-date" : typeof value === "number" ? "metadata-number" : "metadata-text";
  return (
    <div className={kind}>
      <dt>{label}</dt>
      <dd>{date ? <RecordedDate value={value} /> : <RecordedValue value={value} />}</dd>
    </div>
  );
}

const scanLabels: Record<string, string> = {
  rule: "Rule", severity: "Severity", file: "File", line: "Line", match: "Match",
};
export function ScanFindings({ flags }: { flags: unknown[] | null }) {
  if (!flags) return <p>Scan findings not recorded.</p>;
  if (!flags.length) return <p>No scan findings recorded.</p>;
  const findings = (
    <ol className="scan-findings">
      {flags.map((flag, index) => (
        <li key={index}>
          {object(flag) ? (
            <dl className="metadata-fields">
              {Object.entries(flag).map(([key, value]) => (
                <MetadataField key={key} label={Object.hasOwn(scanLabels, key) ? scanLabels[key] : key} value={value} />
              ))}
            </dl>
          ) : (
            <p className="detail-plain"><RecordedValue value={flag} /></p>
          )}
        </li>
      ))}
    </ol>
  );
  const count = `${flags.length} scan ${flags.length === 1 ? "finding" : "findings"}`;
  if (flags.length <= 3) return <div><p>{count}</p>{findings}</div>;
  return (
    <details className="metadata-disclosure">
      <summary>{count}</summary>
      <div className="metadata-scroll" tabIndex={0} role="region" aria-label="Recorded scan findings">
        {findings}
      </div>
    </details>
  );
}

const qualityLabels: Record<string, string> = {
  reuse: "Reuse", health: "Health", content: "Content", trigger: "Trigger",
  verdict: "Verdict", audited_at: "Audited at",
};
export function QualityAssessment({ quality }: { quality: Record<string, unknown> | null }) {
  if (!quality) return <p>Quality assessment not recorded.</p>;
  const known = Object.entries(qualityLabels).filter(([key]) => Object.hasOwn(quality, key));
  const other = Object.entries(quality).filter(([key]) => !Object.hasOwn(qualityLabels, key));
  return (
    <>
      {known.length ? (
        <dl className="detail-fields quality-fields">
          {known.map(([key, label]) => (
            <MetadataField key={key} label={label} value={quality[key]} date={key === "audited_at"} />
          ))}
        </dl>
      ) : <p>No standard quality fields recorded.</p>}
      {other.length > 0 && (
        <details className="metadata-disclosure">
          <summary>Additional recorded fields</summary>
          <div className="metadata-scroll" tabIndex={0} role="region" aria-label="Additional quality fields">
            <dl className="metadata-fields">
              {other.map(([key, value]) => <MetadataField key={key} label={key} value={value} />)}
            </dl>
          </div>
        </details>
      )}
    </>
  );
}
