import { t } from "./i18n";
import { useListDrag } from "./useListDrag";

/** `fixed` chips (e.g. "no category") stay where they are when the others are dragged. */
export type FilterChip = { key: string; label: string; count: number; fixed?: boolean };

type FilterChipsProps = {
  label: string;
  chips: FilterChip[];
  /** Key of the selected chip; null shows everything. */
  active: string | null;
  onChange: (key: string | null) => void;
  /** With this, chips can be dragged into a new order. */
  onReorder?: (source: string, target: string, after: boolean) => void;
};

/** A row of toggle chips ("All", then one per category or tag). Clicking the active chip again clears the filter. */
export default function FilterChips({ label, chips, active, onChange, onReorder }: FilterChipsProps) {
  const isFixed = (key: string) => chips.find((chip) => chip.key === key)?.fixed ?? true;
  const drag = useListDrag({
    scope: "chip",
    axis: "x",
    label: (key) => chips.find((chip) => chip.key === key)?.label ?? key,
    canDrop: (_source, target) => !isFixed(target),
    onDrop: (source, target, after) => onReorder?.(source, target, after),
    disabled: !onReorder,
  });
  if (chips.length === 0) return null;
  return (
    <div aria-label={label} className="filter-chips" role="toolbar">
      <button aria-pressed={active === null} className="filter-chip" onClick={() => onChange(null)} type="button">{t("filter.all")}</button>
      {chips.map((chip) => (
        <button
          aria-pressed={active === chip.key}
          className={`filter-chip${drag.draggingKey === chip.key ? " list-drag-source" : ""}`}
          key={chip.key}
          onClick={() => onChange(active === chip.key ? null : chip.key)}
          title={onReorder && !chip.fixed ? `${chip.label}\n${t("drag.reorderHint")}` : chip.label}
          type="button"
          {...(onReorder && !chip.fixed ? drag.itemProps(chip.key) : {})}
        >
          <span className="filter-chip-label">{chip.label}</span>
          <span className="filter-chip-count">{chip.count}</span>
        </button>
      ))}
      {drag.overlay}
    </div>
  );
}
