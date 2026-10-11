import type { ReactNode } from 'react';

export type PillTone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'info' | 'marketing';

const TONE_CLASS: Record<PillTone, string> = {
  neutral: 'border-border text-content-secondary',
  brand: 'border-brand/45 text-brand-300 bg-brand-500/12',
  success: 'border-success/40 text-success bg-success/12',
  warning: 'border-warning/40 text-warning bg-warning/12',
  danger: 'border-danger/40 text-danger bg-danger/12',
  info: 'border-info/40 text-info bg-info/12',
  // 原小云雀紫，降级为「营销场景」语义色，不作为第二主色使用（见 DesignToken §1.3）
  marketing: 'border-marketing/40 text-marketing bg-marketing/12',
};

export interface PillProps {
  children: ReactNode;
  tone?: PillTone;
  title?: string;
  testId?: string;
}

/** 胶囊标签。状态色只做描边与文字，不做大面积填充（见 DesignToken §4） */
export function Pill({ children, tone = 'neutral', title, testId }: PillProps): ReactNode {
  return (
    <span
      data-testid={testId}
      title={title}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] whitespace-nowrap ${TONE_CLASS[tone]}`}
    >
      {children}
    </span>
  );
}
