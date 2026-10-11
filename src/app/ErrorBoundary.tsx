import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * 路由级 ErrorBoundary（对应架构设计 v1.1 · B5.1）
 *
 * 为什么必须有：单 SPA 下任一模块的运行时错误会波及全站。有了它，
 * 一处崩溃只降级该区域，其余模块仍可用 —— 这是「不用微前端」这个决策成立的前提。
 * 配合模块级功能开关，可做到「单独回滚某个模块的发布」。
 */
interface Props {
  children: ReactNode;
  /** 用于日志与埋点的区域标识，例如 'module:studio' */
  scope: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Sprint1 接入埋点后改为上报；此处保留控制台输出便于调试
    console.error(`[ErrorBoundary:${this.props.scope}]`, error, info.componentStack);
  }

  private readonly reset = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        role="alert"
        data-testid="error-boundary"
        className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center"
      >
        <p className="text-content-primary text-sm font-semibold">该区域加载失败</p>
        <p className="text-content-tertiary max-w-md font-mono text-xs break-all">{error.message}</p>
        <button
          type="button"
          onClick={this.reset}
          className="border-border text-content-primary hover:bg-surface-hover rounded-lg border px-3 py-1.5 text-xs"
        >
          重试
        </button>
      </div>
    );
  }
}
