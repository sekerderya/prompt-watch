interface BadgeProps {
  variant?: "a" | "b";
  children: React.ReactNode;
}

export function VariantBadge({ variant, children }: BadgeProps) {
  const tone = variant === "b" ? "pw-badge--b" : "pw-badge--a";
  return <span className={`pw-badge ${tone}`}>{children}</span>;
}

interface StatusProps {
  status: string;
}

export function StatusBadge({ status }: StatusProps) {
  const active = status === "ACTIVE";
  return (
    <span className={`pw-badge ${active ? "pw-badge--active" : "pw-badge--completed"}`}>
      {active ? "ACTIVE" : status}
    </span>
  );
}