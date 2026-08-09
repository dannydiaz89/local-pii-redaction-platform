import type { ButtonHTMLAttributes, HTMLAttributes, PropsWithChildren, ReactNode } from 'react';

export function Button({ className = '', type = 'button', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={`ui-button ${className}`.trim()} type={type} {...props} />;
}

export function Card({ className = '', ...props }: HTMLAttributes<HTMLElement>) {
  return <section className={`ui-card ${className}`.trim()} {...props} />;
}

export function Callout({ tone = 'neutral', children }: PropsWithChildren<{ readonly tone?: 'neutral' | 'positive' | 'critical' }>) {
  return <div className="ui-callout" data-tone={tone}>{children}</div>;
}

export function StatusBadge({ children, tone = 'neutral' }: PropsWithChildren<{ readonly tone?: 'neutral' | 'positive' | 'warning' }>) {
  return <span className="ui-status" data-tone={tone}>{children}</span>;
}

export function Metric({ label, value }: { readonly label: ReactNode; readonly value: ReactNode }) {
  return <div className="ui-metric"><dt>{label}</dt><dd>{value}</dd></div>;
}

export function SelectField({
  id,
  label,
  value,
  onChange,
  children
}: PropsWithChildren<{
  readonly id: string;
  readonly label: ReactNode;
  readonly value: string;
  readonly onChange: React.ChangeEventHandler<HTMLSelectElement>;
}>) {
  return (
    <div className="ui-field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={onChange}>{children}</select>
    </div>
  );
}
