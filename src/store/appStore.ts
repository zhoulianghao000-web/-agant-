import { create } from 'zustand';

/**
 * 全局 store（对应架构设计 v1.1 · B3.3 分层共享）
 *
 * 只放「跨模块读取频繁且体积小」的会话状态。
 *
 * 禁止放进来：资产列表、广场流、任务实体、项目树、画布数据。
 * 那些是服务端真源，必须走 TanStack Query 单一缓存。一旦把实体复制进 store，
 * 就会退化成「同一份资产三处副本」，「列表不刷新」只是时间问题。
 */
export interface TaskSummary {
  /** 仅计数，不含任务实体 —— 顶栏徽标需要跟随任何页面 */
  queued: number;
  running: number;
}

export interface Quota {
  balance: number;
  unit: string;
}

interface AppState {
  // 会话
  sidebarCollapsed: boolean;
  activeProjectId: number | null;
  taskSummary: TaskSummary;
  quota: Quota;

  toggleSidebar: () => void;
  setActiveProject: (projectId: number | null) => void;
  setTaskSummary: (summary: TaskSummary) => void;
  setQuota: (quota: Quota) => void;
}

export const useAppStore = create<AppState>((set) => ({
  sidebarCollapsed: false,
  activeProjectId: null,
  taskSummary: { queued: 0, running: 0 },
  // 初始值与数据模型一致：新工作空间赠送 1000 积分
  quota: { balance: 1000, unit: 'credit' },

  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setActiveProject: (activeProjectId) => set({ activeProjectId }),
  setTaskSummary: (taskSummary) => set({ taskSummary }),
  setQuota: (quota) => set({ quota }),
}));
