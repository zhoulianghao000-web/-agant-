import type { ReactNode } from 'react';

export interface EmptyStateProps {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  testId?: string;
}

/**
 * 空状态。
 *
 * 广场的空态是**产品语义**而非异常：取消人工选品后（DR-002），
 * 上线初期广场必然为空，空态必须给出「去创作并公开」的下一步引导，
 * 否则用户会认为功能坏了。
 */
export function EmptyState({ title, description, action, testId }: EmptyStateProps): ReactNode {
  return (
    <div
      data-testid={testId}
      className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center"
    >
      <p className="text-content-primary text-[13px] font-medium">{title}</p>
      {description && <p className="text-content-tertiary max-w-sm text-[11.5px] leading-relaxed">{description}</p>}
      {action}
    </div>
  );
}
