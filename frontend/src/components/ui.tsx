// Toolbar controls. Every control is h-7 (28px) with the same radius and padding.
import type { ReactNode } from "react";

export interface Option<T extends string> {
  value: T;
  label: ReactNode;
  title?: string;
}

interface SegmentedProps<T extends string> {
  options: Option<T>[];
  value: T | null;
  onChange: (value: T) => void;
  ariaLabel: string;
  size?: "md" | "sm"; // sm: inside a panel header
}

export function Segmented<T extends string>({ options, value, onChange, ariaLabel, size = "md" }: SegmentedProps<T>) {
  const h = size === "md" ? "h-7" : "h-6";
  return (
    <div className={`flex ${h} items-center rounded-md border border-line bg-white/5 p-0.5`} role="group" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          title={o.title}
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={`flex h-full items-center rounded px-2.5 text-xs font-medium whitespace-nowrap transition-colors ${
            value === o.value ? "bg-accent text-white" : "text-white/60 hover:text-white"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

interface SwitchProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  title?: string;
  tone?: "accent" | "warn";
}

/** A labeled on/off control, h-7 like the segmented controls. */
export function Switch({ label, checked, onChange, title, tone = "accent" }: SwitchProps) {
  const on = tone === "warn" ? "bg-amber-400" : "bg-accent";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      title={title}
      onClick={() => onChange(!checked)}
      className="flex h-7 items-center gap-2 rounded-md border border-line bg-white/5 px-2.5 text-xs font-medium text-white/70 hover:text-white"
    >
      {label}
      <span className={`relative h-3.5 w-6 rounded-full transition-colors ${checked ? on : "bg-white/20"}`}>
        <span className={`absolute left-0.5 top-0.5 h-2.5 w-2.5 rounded-full bg-white transition-transform ${checked ? "translate-x-2.5" : ""}`} />
      </span>
    </button>
  );
}
