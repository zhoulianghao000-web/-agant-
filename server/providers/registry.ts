/**
 * Model Registry（对应架构设计 v1.2 · B4.1）
 *
 * 职责只有一个：让「前端参数面板显示什么」与「后端实际调谁」都从这里读，
 * 而不是各自硬编码。这样换供应商、切主备、调价都只改一处。
 *
 * P0 范围（DR-005 / B6.2）：只做 `txt2img` + `img2video` 两个能力、只接 1 家 Provider。
 * 下方条目中的 cost/latency profile 为**占位值**，待 0.1 实测后回填 —— 标注 `pending: true`
 * 的项表示尚未核实，禁止在界面上当作真实数据展示。
 */

import type { Capability } from './types';
import { GenericHttpProvider } from './http-generic';
import { StubProvider } from './stub';
import { loadProviderConfig, reportProviderConfig, type ProviderConfig } from '../config';
import type { ProviderAdapter } from './types';

export interface CostProfile {
  unit: 'per_image' | 'per_second' | 'per_1k_token';
  price: number;
  currency: string;
  /** true = 尚未实测核实，仅为占位 */
  pending: boolean;
}

export interface LatencyProfile {
  p50Ms: number;
  p95Ms: number;
  pending: boolean;
}

export interface ModelEntry {
  modelKey: string;
  displayName: string;
  capability: Capability;
  costProfile: CostProfile;
  latencyProfile: LatencyProfile;
  isPrimary: boolean;
  /** 主模型不可用时切换到哪个（对应 R1/R2 的备选预案） */
  fallbackOf?: string;
}

/**
 * 占位注册表：键名与结构已冻结，数值待 0.1 实测回填。
 * 刻意保留 `pending: true` —— 让「未核实」在数据里可见，而不是靠人记。
 */
export const MODEL_REGISTRY: readonly ModelEntry[] = [
  {
    modelKey: 'txt2img-p0',
    displayName: '文生图（P0 主）',
    capability: 'txt2img',
    costProfile: { unit: 'per_image', price: 0, currency: 'CNY', pending: true },
    latencyProfile: { p50Ms: 0, p95Ms: 0, pending: true },
    isPrimary: true,
  },
  {
    modelKey: 'img2video-p0',
    displayName: '图生视频（P0 主）',
    capability: 'img2video',
    costProfile: { unit: 'per_second', price: 0, currency: 'CNY', pending: true },
    latencyProfile: { p50Ms: 0, p95Ms: 0, pending: true },
    isPrimary: true,
  },
];

export function modelsFor(capability: Capability): readonly ModelEntry[] {
  return MODEL_REGISTRY.filter((m) => m.capability === capability);
}

export function findModel(modelKey: string): ModelEntry | undefined {
  return MODEL_REGISTRY.find((m) => m.modelKey === modelKey);
}

export interface ResolvedProvider {
  adapter: ProviderAdapter;
  config: ProviderConfig;
  /** 是否降级到了 stub（即 Key 未配置） */
  usingStub: boolean;
  report: ReturnType<typeof reportProviderConfig>;
}

/**
 * 决定用哪个适配器。
 *
 * 关键行为：**Key 没配时不抛错，而是降级到 stub 并明确标记 `usingStub: true`**。
 * 理由：阶段 0 的 Key 下发可能拖几天，不能让整条链路停摆；
 * 但必须让「当前是假数据」这件事在状态接口里一眼可见，否则会拿 mock 结果当真实联调结论。
 */
export function resolveProvider(overrides: Partial<ProviderConfig> = {}): ResolvedProvider {
  const base = loadProviderConfig();
  const config: ProviderConfig = { ...base, ...overrides };
  const report = reportProviderConfig(config);

  if (report.configured) {
    return { adapter: new GenericHttpProvider(config), config, usingStub: false, report };
  }
  return { adapter: new StubProvider(), config, usingStub: true, report };
}
