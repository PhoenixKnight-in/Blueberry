/**
 * One number in the KPI row.
 *
 * A stat tile rather than a one-bar chart: these are headline values a reader
 * looks *at*, not magnitudes they compare across. Plotting them would add
 * nothing to read and a legend to ignore.
 */

interface StatTileProps {
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
  /** Marks the tile that represents work outstanding. */
  readonly emphasis?: boolean;
}

export function StatTile({ label, value, hint, emphasis = false }: StatTileProps) {
  return (
    <div className={`stat-tile${emphasis ? ' stat-tile--critical' : ''}`}>
      <div className="stat-tile__label">{label}</div>
      <div className="stat-tile__value">{value}</div>
      {hint ? <div className="stat-tile__hint">{hint}</div> : null}
    </div>
  );
}
