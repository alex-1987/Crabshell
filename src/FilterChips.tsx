import { t } from "./i18n";

export type FilterChip = { key: string; label: string; count: number };

type FilterChipsProps = {
  label: string;
  chips: FilterChip[];
  /** Key of the selected chip; null shows everything. */
  active: string | null;
  onChange: (key: string | null) => void;
};

/** A row of toggle chips ("All", then one per category or tag). Clicking the active chip again clears the filter. */
export default function FilterChips({ label, chips, active, onChange }: FilterChipsProps) {
  if (chips.length === 0) return null;
  return (
    <div aria-label={label} className="filter-chips" role="toolbar">
      <button aria-pressed={active === null} className="filter-chip" onClick={() => onChange(null)} type="button">{t("filter.all")}</button>
      {chips.map((chip) => (
        <button
          aria-pressed={active === chip.key}
          className="filter-chip"
          key={chip.key}
          onClick={() => onChange(active === chip.key ? null : chip.key)}
          title={chip.label}
          type="button"
        >
          <span className="filter-chip-label">{chip.label}</span>
          <span className="filter-chip-count">{chip.count}</span>
        </button>
      ))}
    </div>
  );
}
