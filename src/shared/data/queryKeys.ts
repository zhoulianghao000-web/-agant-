/**
 * Query key 唯一工厂（对应 阶段0-前端约定-v1.md §2）
 *
 * 铁律：所有 query key 必须来自本文件。禁止在业务代码里手写数组字面量。
 * 只有这样，SSE 的「按类型精确失效」才有可维护的落脚点 —— 见 sse.ts 的失效映射表。
 */

export interface AssetFilters {
  projectId?: number;
  type?: string;
  visibility?: string;
  unreferenced?: boolean;
  cursor?: string;
}

export interface JobFilters {
  status: string;
  cursor?: string;
}

export const qk = {
  // ---- 会话与目录 ----
  me: () => ['me'] as const,
  workspace: () => ['workspace'] as const,
  models: () => ['catalog', 'models'] as const,
  skills: () => ['catalog', 'skills'] as const,

  // ---- 积分 ----
  credits: () => ['credits', 'balance'] as const,
  ledger: (cursor?: string) => ['credits', 'ledger', cursor ?? 'first'] as const,

  // ---- 任务 ----
  jobs: ({ status, cursor }: JobFilters) => ['jobs', status, cursor ?? 'first'] as const,
  job: (id: number) => ['jobs', 'detail', id] as const,

  // ---- 资产 / 项目 / 画布 ----
  assets: (filters: AssetFilters = {}) => ['assets', 'list', filters] as const,
  asset: (id: number) => ['assets', 'detail', id] as const,
  projects: () => ['projects', 'list'] as const,
  canvas: (id: number) => ['canvases', id] as const,

  // ---- 广场 ----
  discover: (tab: string, cursor?: string) => ['discover', tab, cursor ?? 'first'] as const,
} as const;

/**
 * SSE 事件 → 需失效的 key 前缀。
 *
 * 关键设计：`progress` 不失效任何 query。任务进度是每秒多次更新，
 * 若每次都拉列表，会把「实时感」换成「整页抖动」。进度走独立的轻量 store。
 */
export const SSE_INVALIDATION_MAP: Record<string, readonly (readonly unknown[])[]> = {
  queued: [],
  running: [],
  progress: [],
  succeeded: [['jobs'], ['assets', 'list'], ['credits']],
  failed: [['jobs'], ['credits']],
  blocked: [['jobs'], ['credits']],
};
