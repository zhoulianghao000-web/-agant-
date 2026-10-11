import { useEffect, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { installVisibilityBridge, sseClient } from '@/shared/data/sse';

/**
 * QueryClient 全局单例。
 *
 * 关键约束（见 阶段0-前端约定-v1.md §2.1）：失效必须按 queryKey 前缀精确进行，
 * 禁止无参 invalidateQueries —— 该规则已由 ESLint 的 no-restricted-syntax 强制。
 */
function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // 领域数据是服务端真源，不做本地副本；但短时间内的重复挂载不必重复请求
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        retry: 1,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: 0 },
    },
  });
}

export function AppProviders({ children }: { children: ReactNode }): ReactNode {
  const [queryClient] = useState(createQueryClient);

  // SSE 连接由 Shell 统一持有：全站一条连接，绝不在组件内 new EventSource
  useEffect(() => {
    // 先绑定 queryClient，SSE 事件才能按类型精确失效
    sseClient.bind(queryClient);
    const removeVisibilityBridge = installVisibilityBridge();
    sseClient.connect();
    return () => {
      removeVisibilityBridge();
      sseClient.disconnect();
    };
  }, [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>{children}</BrowserRouter>
    </QueryClientProvider>
  );
}
