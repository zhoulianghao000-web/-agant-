import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { MODULES, isModuleEnabled } from './moduleRegistry';
import { ErrorBoundary } from './ErrorBoundary';
import { useAppStore } from '@/store/appStore';

/**
 * App Shell（对应架构设计 v1.1 · B5.2）
 *
 * 布局职责只做三件事：
 *   1. 左侧可折叠侧栏：一级项 = 三个模块（恒定置顶）；二级项在模块内下钻（Sprint1 起填）
 *   2. 顶部通栏：只放跨模块恒定可达的全局职能（全局搜索 / 任务中心 / 积分 / 账号）
 *   3. 内容区：唯一滚动容器
 *
 * 为什么模块切换放在侧栏一级而不是顶部 Tab：顶部 Tab 会与模块内二级导航争抢层级，
 * 导致 M2 的「项目 → 画布/素材/主体」三级无处安放。
 */
export function AppShell(): React.ReactNode {
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const runningCount = useAppStore((s) => s.taskSummary.running);
  const balance = useAppStore((s) => s.quota.balance);
  const location = useLocation();

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-bg-base">
      {/* ---------------- 左侧侧栏 ---------------- */}
      <aside
        data-testid="sidebar"
        style={{ width: sidebarCollapsed ? 64 : 200 }}
        className="bg-bg-elevated border-border flex shrink-0 flex-col border-r transition-[width] duration-200"
      >
        <div className="border-border flex h-12 items-center gap-2 border-b px-3">
          <span className="bg-brand h-5 w-5 shrink-0 rounded-md" aria-hidden />
          {!sidebarCollapsed && <span className="text-content-primary text-sm font-semibold">AIGC</span>}
          <button
            type="button"
            onClick={toggleSidebar}
            aria-label={sidebarCollapsed ? '展开侧栏' : '折叠侧栏'}
            className="text-content-tertiary hover:text-content-primary ml-auto text-xs"
          >
            {sidebarCollapsed ? '»' : '«'}
          </button>
        </div>

        <nav className="flex flex-col gap-1 p-2" aria-label="模块导航">
          {MODULES.map((m) => {
            const enabled = isModuleEnabled(m);
            const active = location.pathname.startsWith(m.path);
            return (
              <NavLink
                key={m.key}
                to={m.path}
                title={m.purpose}
                data-testid={`nav-${m.key}`}
                aria-current={active ? 'page' : undefined}
                aria-disabled={!enabled}
                onClick={(e) => {
                  if (!enabled) e.preventDefault();
                }}
                className={[
                  'flex h-9 items-center rounded-lg px-2.5 text-[13px] transition-colors',
                  enabled ? 'hover:bg-surface-hover' : 'cursor-not-allowed opacity-40',
                  active ? 'bg-surface-hover text-content-primary font-medium' : 'text-content-secondary',
                ].join(' ')}
              >
                <span className="truncate">{m.label}</span>
              </NavLink>
            );
          })}
        </nav>

        <div className="border-border text-content-disabled mt-auto border-t p-3 text-[11px]">
          {!sidebarCollapsed && <span>阶段 0 · 骨架</span>}
        </div>
      </aside>

      {/* ---------------- 右侧主区 ---------------- */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="bg-bg-elevated border-border flex h-12 shrink-0 items-center gap-3 border-b px-4">
          <span className="text-content-tertiary text-xs">全局搜索（Sprint1）</span>

          <div className="ml-auto flex items-center gap-2">
            <span
              data-testid="task-center"
              className="pill border-border text-content-secondary border"
              title="全局任务中心（Sprint1）：跨模块可见，切换模块不中断"
            >
              进行中 <b className="text-content-primary tabular-nums">{runningCount}</b>
            </span>
            <span className="pill border-border text-content-secondary border" title="积分余额">
              积分 <b className="text-content-primary tabular-nums">{balance}</b>
            </span>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <ErrorBoundary scope="app-shell">
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
