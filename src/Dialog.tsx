import type { KeyboardEvent, ReactNode } from "react";

type DialogProps = {
  /** Id of the title element (`aria-labelledby`). */
  titleId: string;
  eyebrow: ReactNode;
  title: ReactNode;
  closeLabel: string;
  onClose: () => void;
  /** Extra class next to `server-dialog`, e.g. "paste-dialog". */
  className?: string;
  /** Clicking the dimmed backdrop closes the dialog (default). Off for decisions that need an answer. */
  closeOnBackdrop?: boolean;
  /** Replaces the default handling (Escape closes). */
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  children: ReactNode;
};

/** Modal dialog frame: dimmed backdrop, eyebrow + title, × button. */
export default function Dialog({ titleId, eyebrow, title, closeLabel, onClose, className, closeOnBackdrop = true, onKeyDown, children }: DialogProps) {
  return (
    <div
      className="dialog-scrim"
      onKeyDown={onKeyDown ?? ((event) => { if (event.key === "Escape") onClose(); })}
      onMouseDown={(event) => { if (closeOnBackdrop && event.target === event.currentTarget) onClose(); }}
      role="presentation"
    >
      <section aria-labelledby={titleId} aria-modal="true" className={`server-dialog${className ? ` ${className}` : ""}`} role="dialog">
        <header className="dialog-heading">
          <div><div className="page-eyebrow">{eyebrow}</div><h2 id={titleId}>{title}</h2></div>
          <button aria-label={closeLabel} className="icon-button" onClick={onClose} type="button">×</button>
        </header>
        {children}
      </section>
    </div>
  );
}
