import { lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './AppShell';
import { ErrorBoundary } from './ErrorBoundary';
import { DEFAULT_MODULE, MODULES, moduleByKey } from './moduleRegistry';

/**
 * 路由表（对应架构设计 v1.1 · B5.1 / B5.2）
 *
 * - 按模块懒加载：模块切换的代价从「全量 bundle」降到「一个 chunk」
 * - 每个模块包一层 ErrorBoundary：单模块崩溃不影响其余模块
 * - 默认重定向到 DEFAULT_MODULE，而不是根路径渲染首页 —— 避免出现「第四个隐式模块」
 */
const StudioPage = lazy(() => import('@/features/studio'));
const AssetsPage = lazy(() => import('@/features/assets'));
const DiscoverPage = lazy(() => import('@/features/discover'));

const PAGE_BY_MODULE: Record<string, React.LazyExoticComponent<() => ReactNode>> = {
  studio: StudioPage,
  assets: AssetsPage,
  discover: DiscoverPage,
};

function ModuleRoute({ moduleKey }: { moduleKey: string }): ReactNode {
  const Page = PAGE_BY_MODULE[moduleKey];
  if (!Page) return <div className="text-content-tertiary p-6 text-xs">未知模块：{moduleKey}</div>;
  return (
    <ErrorBoundary scope={`module:${moduleKey}`}>
      <Suspense fallback={<div className="text-content-tertiary p-6 text-xs">加载中…</div>}>
        <Page />
      </Suspense>
    </ErrorBoundary>
  );
}

export function AppRouter(): ReactNode {
  const fallback = moduleByKey(DEFAULT_MODULE)?.path ?? '/create';

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Navigate to={fallback} replace />} />
        {MODULES.map((m) => (
          <Route
            key={m.key}
            path={`${m.path}/*`}
            element={<ModuleRoute moduleKey={m.key} />}
          />
        ))}
        <Route path="*" element={<Navigate to={fallback} replace />} />
      </Route>
    </Routes>
  );
}
