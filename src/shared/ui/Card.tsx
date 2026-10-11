import type { ReactNode } from 'react';

export interface CardProps {
  title?: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
  testId?: string;
}

/** 卡片：圆角 12px、描边、深色表面。唯一的容器原语，避免各页面自造边框 */
export function Card({ title, hint, children, className = '', testId }: CardProps): ReactNode {
  return (
    <section data-testid={testId} className={`border-border bg-surface rounded-xl border ${className}`}>
      {(title || hint) && (
        <header className="border-border flex items-center gap-2 border-b px-3 py-2.5">
          {title && <h2 className="text-content-primary text-[12.5px] font-semibold">{title}</h2>}
          {hint && <span className="text-content-tertiary ml-auto text-[11px]">{hint}</span>}
        </header>
      )}
      <div className="p-3">{children}</div>
    </section>
  );
}
