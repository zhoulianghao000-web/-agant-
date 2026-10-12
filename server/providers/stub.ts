/**
 * Stub Provider —— 让「没 Key」不阻塞开发
 *
 * 存在的理由（这条是刻意的，不是权宜之计）：
 *   阶段 0 的 0.1 是「申请 Key」，而 Key 下发可能拖几天。如果适配层必须等 Key 才能跑，
 *   整条链路（提交 → 进度 → 落库 → 一键同款）就会被一个外部审批卡住。
 *   有了 stub，前端与任务总线可以先把闭环跑通，Key 到位后只切一个 adapter。
 *
 * 它也是**故障注入的唯一合法位置**：失败率/拦截率/耗时都在这里模拟，
 * 绝不允许把「假数据」散落进业务代码。
 *
 * 明确不做的事：不产生真实文件、不消耗任何第三方配额、不写库。
 * 产物 URL 刻意用 `stub://` 前缀，避免被误当成真实可访问的资源。
 */

import type {
  Capability,
  PlatformFailure,
  PollResult,
  ProviderAdapter,
  ProviderJobStatus,
  SubmitInput,
  SubmitResult,
} from './types';
import { normalizeError } from './errors';

interface StubJob {
  id: string;
  input: SubmitInput;
  startedAt: number;
  status: ProviderJobStatus;
  plannedDurationMs: number;
  terminal?: PollResult['failure'];
}

function envNumber(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export interface StubOptions {
  /** 任务模拟耗时（毫秒） */
  durationMs?: number;
  /** 0–1，模拟厂商侧失败 */
  failRate?: number;
  /** 0–1，模拟内容审核拦截 */
  blockRate?: number;
}

export class StubProvider implements ProviderAdapter {
  readonly id = 'stub';
  readonly displayName = 'Stub Provider（无 Key 可用，仅供本地联调）';
  readonly requiresKey = false;
  readonly configured = true;

  private readonly jobs = new Map<string, StubJob>();
  private seq = 0;
  private readonly opts: Required<StubOptions>;

  constructor(options: StubOptions = {}) {
    this.opts = {
      durationMs: options.durationMs ?? envNumber('STUB_DURATION_MS', 6000),
      failRate: options.failRate ?? envNumber('STUB_FAIL_RATE', 0),
      blockRate: options.blockRate ?? envNumber('STUB_BLOCK_RATE', 0),
    };
  }

  capabilities(): Capability[] {
    return ['txt2img', 'img2video'];
  }

  async submit(input: SubmitInput): Promise<SubmitResult> {
    this.seq += 1;
    const id = `stub_${Date.now().toString(36)}_${this.seq}`;
    this.jobs.set(id, {
      id,
      input,
      startedAt: Date.now(),
      status: 'queued',
      plannedDurationMs: this.opts.durationMs,
    });
    return { providerJobId: id, acceptedAt: new Date().toISOString() };
  }

  async poll(providerJobId: string): Promise<PollResult> {
    const job = this.jobs.get(providerJobId);
    if (!job) {
      return {
        status: 'failed',
        progress: 0,
        failure: normalizeError('job not found', { context: '400 invalid' }),
      };
    }

    const elapsed = Date.now() - job.startedAt;
    const ratio = Math.min(1, elapsed / Math.max(1, job.plannedDurationMs));

    if (ratio < 0.15) return { status: 'queued', progress: Math.round(ratio * 30) };
    if (ratio < 1) {
      job.status = 'running';
      return { status: 'running', progress: Math.max(5, Math.round(ratio * 100)) };
    }

    // 结算终态（只结算一次）
    if (job.status === 'running' || job.status === 'queued') {
      const roll = Math.random();
      if (roll < this.opts.blockRate) {
        job.status = 'blocked';
        job.terminal = normalizeError(
          { code: 'content_policy_violation', message: '内容审核未通过（stub 注入）' },
          {},
        );
      } else if (roll < this.opts.blockRate + this.opts.failRate) {
        job.status = 'failed';
        job.terminal = normalizeError({ code: 'internal_error', message: '厂商内部错误（stub 注入）' }, {});
      } else {
        job.status = 'succeeded';
      }
    }

    if (job.status === 'succeeded') {
      const isVideo = job.input.capability === 'img2video' || job.input.capability === 'txt2video';
      return {
        status: 'succeeded',
        progress: 100,
        artifacts: [
          {
            // 刻意用 stub:// 前缀：避免被当成真实可访问资源，也便于在数据里一眼识别
            url: `stub://artifact/${job.id}.${isVideo ? 'mp4' : 'png'}`,
            width: 1024,
            height: isVideo ? 576 : 1024,
            durationMs: isVideo ? (job.input.durationSeconds ?? 5) * 1000 : undefined,
          },
        ],
        raw: { stub: true, modelKey: job.input.modelKey, seed: job.input.seed },
      };
    }

    return {
      status: job.status,
      progress: 100,
      failure: job.terminal as PlatformFailure,
      raw: { stub: true },
    };
  }

  async cancel(providerJobId: string): Promise<{ cancelled: boolean }> {
    const job = this.jobs.get(providerJobId);
    if (!job) return { cancelled: false };
    if (job.status === 'queued' || job.status === 'running') {
      job.status = 'failed';
      job.terminal = normalizeError({ code: 'user_cancelled', message: '用户取消' }, {});
      return { cancelled: true };
    }
    return { cancelled: false };
  }

  normalize(input: unknown): PlatformFailure {
    return normalizeError(input);
  }
}
