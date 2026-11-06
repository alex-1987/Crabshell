import logoUrl from "./assets/crabshell.svg";

/** The Crabshell crab logo (same artwork as the app and taskbar icon). */
export default function BrandMark({ size = 36, className = "" }: { size?: number; className?: string }) {
  return <img alt="" aria-hidden="true" className={`brand-mark ${className}`.trim()} draggable={false} height={size} src={logoUrl} width={size} />;
}
