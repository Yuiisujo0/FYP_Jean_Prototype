import type { ReactNode } from 'react';

type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'accent' | 'outline';

export function Badge({ tone = 'neutral', dot, children }: { tone?: Tone; dot?: boolean; children: ReactNode }) {
  return (
    <span className={`badge ${tone !== 'neutral' ? `badge--${tone}` : ''}`}>
      {dot && <i aria-hidden />}
      {children}
    </span>
  );
}
