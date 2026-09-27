// Controls: "lg" h-9 (36px) in the controls row, "xl" h-11 (44px) in the page header, "sm" h-6 in panel headers.
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
  size?: "xl" | "lg" | "sm";
}

export function Segmented<T extends string>({ options, value, onChange, ariaLabel, size = "lg" }: SegmentedProps<T>) {
  const h = { xl: "h-11", lg: "h-9", sm: "h-6" }[size];
  const text = { xl: "px-4 text-base", lg: "px-3 text-sm", sm: "px-2.5 text-xs" }[size];
  return (
    <div className={`flex ${h} items-center rounded-md border border-line bg-white/5 p-0.5`} role="group" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          title={o.title}
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={`flex h-full items-center rounded ${text} font-medium whitespace-nowrap transition-colors ${
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

/** A labeled on/off control, h-9 like the segmented controls. */
export function Switch({ label, checked, onChange, title, tone = "accent" }: SwitchProps) {
  const on = tone === "warn" ? "bg-amber-400" : "bg-accent";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      title={title}
      onClick={() => onChange(!checked)}
      className="flex h-9 items-center gap-2 rounded-md border border-line bg-white/5 px-3 text-sm font-medium text-white/70 hover:text-white"
    >
      {label}
      <span className={`relative h-4 w-7 rounded-full transition-colors ${checked ? on : "bg-white/20"}`}>
        <span className={`absolute left-0.5 top-0.5 h-3 w-3 rounded-full bg-white transition-transform ${checked ? "translate-x-3" : ""}`} />
      </span>
    </button>
  );
}
