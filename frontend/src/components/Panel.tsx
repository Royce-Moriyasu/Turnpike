import type { ReactNode } from "react";

interface Props {
  title: ReactNode;
  right?: ReactNode; // status or action on the right of the header
  children: ReactNode;
  className?: string; // on the panel (e.g. flex-1 to fill a column)
  bodyClassName?: string; // on the body (default padding p-3)
  tone?: "default" | "accent" | "warn"; // border: accent = maneuver imminent, warn = debug
}

const BORDER = { default: "border-line", accent: "border-accent", warn: "border-amber-400/40" };

/** Every dashboard panel: one background, border, radius, padding and header style. */
export default function Panel({ title, right, children, className = "", bodyClassName = "p-3", tone = "default" }: Props) {
  return (
    <section className={`flex min-w-0 flex-col rounded-lg border bg-surface ${BORDER[tone]} ${className}`}>
      <header className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-line px-3">
        <h2 className={`label ${tone === "warn" ? "text-amber-300/80" : ""}`}>{title}</h2>
        {right && <div className="flex min-w-0 items-center gap-2 text-[11px]">{right}</div>}
      </header>
      <div className={`min-h-0 flex-1 ${bodyClassName}`}>{children}</div>
    </section>
  );
}
