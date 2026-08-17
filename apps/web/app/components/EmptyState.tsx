interface EmptyStateProps {
  icon?: string;
  title: string;
  body: string;
  action?: string;
}

export default function EmptyState({ icon = "▾", title, body, action }: EmptyStateProps) {
  return (
    <div className="pw-empty">
      <div className="pw-empty__icon" aria-hidden="true">
        {icon}
      </div>
      <div className="pw-empty__title">{title}</div>
      <div className="pw-empty__body">{body}</div>
      {action && <code className="pw-chip">{action}</code>}
    </div>
  );
}