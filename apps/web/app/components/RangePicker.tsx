"use client";

/** The dashboard was hardcoded to 7 days, with no way to look further back. */
export const RANGE_OPTIONS = [7, 30, 90] as const;
export const DEFAULT_RANGE_DAYS = 7;

export default function RangePicker({
  days,
  onChange,
}: {
  days: number;
  onChange: (days: number) => void;
}) {
  return (
    <div className="pw-range" role="group" aria-label="Time range">
      {RANGE_OPTIONS.map((option) => (
        <button
          key={option}
          type="button"
          className={`pw-range__option${days === option ? " pw-range__option--active" : ""}`}
          aria-pressed={days === option}
          onClick={() => onChange(option)}
        >
          {option}d
        </button>
      ))}
    </div>
  );
}
