import type { components } from './generated';

/**
 * API 类型入口（评审发现 F6 / G6 闭环）。
 *
 * 自 2026-10-12 起，**实体类型全部由契约生成**（`npm run contract:types`）。
 * 本文件不再手抄字段 —— 手抄契约的后果是字段漂移，而漂移不会让任何一侧编译失败，
 * 只会在联调时以「后端返回了但前端没定义」的形式爆发。
 *
 * 手写内容只剩两类：
 *   1. 客户端侧的查询参数形状（契约里是 query 参数，不是可复用的 schema）
 *   2. 跨模块共用的分页包装（契约在各端点内联了 items/nextCursor，未抽 schema）
 *
 * ⚠️ 需要改字段时改 **contracts/openapi.yaml**，然后跑 `npm run contract:types`。
 *    直接改本文件会在下一次生成时被覆盖。
 */

type Schemas = components['schemas'];

// ---------------------------------------------------------------- 实体
export type Problem = Schemas['Problem'];
export type GenSnapshot = Schemas['GenSnapshot'];
export type Asset = Schemas['Asset'];
export type Job = Schemas['Job'];
export type JobEvent = Schemas['JobEvent'];
export type JobCreateRequest = Schemas['JobCreateRequest'];
export type Project = Schemas['Project'];
export type Canvas = Schemas['Canvas'];
export type CanvasNode = Schemas['CanvasNode'];
export type CanvasWrite = Schemas['CanvasWrite'];
export type CanvasViewport = Schemas['Canvas']['viewport'];
export type UploadSession = Schemas['UploadSession'];
export type ReviewAppeal = Schemas['ReviewAppeal'];
export type LedgerEntry = Schemas['LedgerEntry'];
export type CreditBalance = Schemas['CreditBalance'];
export type Model = Schemas['Model'];
export type Skill = Schemas['Skill'];
export type SkillRef = Schemas['SkillRef'];

// ------------------------------------------------------------------ 枚举
// 一律从实体上取，而不是重新写一遍字面量联合 ——
// 重写一遍就等于又造了一个会漂移的副本，只是漂移地点从字段名换成了枚举值。
export type AssetType = Asset['type'];
export type Visibility = NonNullable<Asset['visibility']>;
export type ReviewStatus = NonNullable<Asset['reviewStatus']>;
export type AppealStatus = NonNullable<Asset['appealStatus']>;
export type JobStatus = NonNullable<Job['status']>;
export type JobErrorCode = NonNullable<Job['errorCode']>;
export type JobEventType = JobEvent['type'];
export type LedgerEntryType = LedgerEntry['type'];
export type ModelCapability = Model['capability'];

// ------------------------------------------------------- 客户端侧手写
/** 资产列表的查询过滤条件（对应 GET /v1/assets 的 query 参数） */
export interface AssetFilters {
  projectId?: number;
  type?: AssetType;
  visibility?: Visibility;
  /** true 时只返回未被任何项目/画布引用的资产，用于「未归类」分组 */
  unreferenced?: boolean;
  cursor?: string;
}

/** 任务列表的查询过滤条件（对应 GET /v1/jobs 的 query 参数） */
export interface JobFilters {
  status: JobStatus | 'active';
  cursor?: string;
}

/** 游标分页包装 */
export interface Paged<T> {
  items: T[];
  nextCursor: string | null;
}

/** 带总数的分页（广场空态判断需要 total === 0） */
export interface PagedWithTotal<T> extends Paged<T> {
  total: number;
}
