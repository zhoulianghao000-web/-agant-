/**
 * API 类型 —— 手工镜像 `阶段0-接口契约-v1.yaml`。
 *
 * ⚠️ Sprint1 任务：改用 openapi-typescript 从契约自动生成，消除前后端字段漂移。
 *    生成后本文件应改为 `export type { ... } from './generated'`，不再手写。
 *
 * 当前手工维护的理由：阶段 0 需要一份「可编译的最小契约类型」来让骨架先跑起来，
 * 而契约本身还在评审中（评审通过前生成会有反复改动的噪音）。
 */

export type AssetType = 'image' | 'video' | 'audio' | 'text';
export type Visibility = 'private' | 'public';
export type ReviewStatus = 'pass' | 'blocked' | 'pending';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled';

/** 异步阶段失败码，与契约定义的 Job.errorCode 枚举一致 */
export type JobErrorCode =
  | 'USER_CANCELLED'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_ERROR'
  | 'CONTENT_BLOCKED_BY_PROVIDER'
  | 'CREDIT_SETTLE_FAILED';

export interface Problem {
  type?: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  [key: string]: unknown;
}

export interface GenSnapshot {
  schemaVersion: 1;
  prompt: string;
  negativePrompt?: string;
  model: string;
  modelVersion?: string;
  seed: number;
  duration?: number;
  aspect?: '16:9' | '9:16' | '1:1' | '4:3' | '3:4';
  style?: string;
  referenceAssetIds?: number[];
  [key: string]: unknown;
}

export interface SkillRef {
  key: string;
  version: number;
}

export interface Asset {
  id: number;
  type: AssetType;
  mediaUrl: string;
  thumbUrl: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  visibility: Visibility;
  reviewStatus: ReviewStatus;
  reviewReason: string | null;
  genSnapshot: GenSnapshot;
  /** 快照的稳定哈希（键序无关），用于判定「一键同款是否改过参数」 */
  snapshotHash: string;
  /** 被项目与画布引用的总数；> 0 时禁止硬删（一键同款链路保护） */
  refCount: number;
  skill?: SkillRef;
  sourceJobId: number | null;
  createdAt: string;
}

export interface Job {
  id: number;
  status: JobStatus;
  progress: number;
  params: Record<string, unknown>;
  preDeducted: number;
  /** 失败 / 取消 / 拦截一律为 0（已全额返还） */
  settled: number;
  errorCode: JobErrorCode | null;
  errorMessage: string | null;
  assetId: number | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface JobEvent {
  eventId: number;
  taskId: number;
  type: 'queued' | 'running' | 'progress' | 'succeeded' | 'failed' | 'blocked';
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface CanvasNode {
  nodeUid: string;
  refType: 'asset';
  refId: number;
  x: number;
  y: number;
  w: number;
  z: number;
}

export interface CanvasViewport {
  x: number;
  y: number;
  scale: number;
}

export interface CanvasDoc {
  id: number;
  name: string;
  viewport: CanvasViewport;
  snap: boolean;
  grid: number;
  nodes: CanvasNode[];
  updatedAt: string;
}

export interface LedgerEntry {
  id: number;
  jobId: number | null;
  type: 'pre' | 'settle' | 'refund' | 'grant' | 'adjust';
  amount: number;
  balanceAfter: number;
  note: string;
  createdAt: string;
}

export interface Paged<T> {
  items: T[];
  nextCursor: string | null;
}
