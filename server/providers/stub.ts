/**
 * Stub Provider —— 让「没 Key」不阻塞开发
 *
 * 存在的理由（刻意的，不是权宜之计）：
 *   0.1 是「申请 Key」，而下发可能拖很久。若适配层必须等 Key 才能跑，
 *   整条链路（提交 → 进度 → 落库 → 一键同款）就会被一个外部审批卡住。
 *   有了 stub，前端与任务总线可以先把闭环跑通，Key 到位后只切一个 adapter。
 *
 * 它也是**故障注入的唯一合法位置**：失败率/拦截率/耗时都在这里模拟，
 * 绝不允许把「假数据」散落进业务代码。
 *
 * 明确不做的事：不产生真实文件、不消耗任何第三方配额、不写库。
 * 产物 URL 刻意用 `stub://` 前缀，避免被误当成真实可访问的资源。
 *
 * ---------------------------------------------------------------------------
 * 2026-10-12 升级：从「随机故障」改为「**可按需驱动的确定性模拟器**」
 *
 * 为什么必须改：原先只能靠 `STUB_FAIL_RATE` / `STUB_BLOCK_RATE` 随机出故障。
 * 这有两个致命问题：
 *   1. **没法按需复现某条失败路径** —— 想验「审核拦截」得走运；
 *   2. **写不了测试** —— 随机 → flaky，而 flaky 的测试最终会被跳过，等于没有。
 *
 * 而 0.3 要区分的恰恰是各类失败（拦截 / 限流 / 超时 / 参数非法），
 * 并且必须区分**同步拒绝**与**异步终态**（执行包 §5 明确要求）—— 这两条在真
 * Provider 到位前就应该能被验证，否则等 Key 到手才第一次跑错误分支，风险太高。
 *
 * 于是引入**约定的触发值**（思路同 Stripe 的测试卡号）：在 prompt 里嵌入
 * `[stub:<场景>]` 即可精确驱动到对应路径。标记对真实调用无意义 ——
 * 它只在 stub 下被解析，切到真 adapter 后就是一段普通文本。
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

export type StubScenario =
  | 'ok'
  | 'blocked'
  | 'failed'
  | 'unavailable'
  | 'timeout'
  | 'ratelimited'
  | 'invalid'
  | 'slow';

export interface ScenarioSpec {
  scenario: StubScenario;
  /**
   * 在哪一阶段拒绝。
   *
   * ⚠️ 这个字段是本次升级的核心：执行包 §5 要求确认
   *    「拦截发生在同步提交阶段还是异步终态」——
   *    前者要求把错误码从异步 `job.errorCode` 提前到 HTTP 4xx，**契约必须改**；
   *    后者不用改。两种情况的 `outcome` 都是失败，靠别的字段区分不出来。
   */
  stage: 'submit' | 'poll' | 'none';
  /** poll 阶段的终态 */
  terminal?: Extract<ProviderJobStatus, 'failed' | 'blocked'>;
  /** 注入的「厂商报文」，交给 normalizeError 归一（走的是真实归一逻辑，不是写死平台码） */
  wire: Record<string, unknown>;
  /** 耗时倍率 */
  durationScale: number;
  description: string;
  /** 该场景是否会让任务正常完成（没有它就说明是失败路径） */
  isHappyPath: boolean;
}

/**
 * 场景表。
 *
 * 每条都刻意让 `wire` 走 **`normalizeError` 的真实归一逻辑**，而不是直接把
 * `PlatformErrorCode` 写死 —— 否则模拟器就绕过了被验证的那段代码，
 * 测出来的「归一正确」毫无意义。
 */
export const STUB_SCENARIOS: readonly ScenarioSpec[] = [
  {
    scenario: 'ok',
    stage: 'none',
    wire: {},
    durationScale: 1,
    description: '正常成功（默认，无标记时走这条）',
    isHappyPath: true,
  },
  {
    scenario: 'blocked',
    stage: 'poll',
    terminal: 'blocked',
    wire: { code: 'content_policy_violation', message: '内容审核未通过' },
    durationScale: 1,
    description: '异步终态：内容审核拦截（对应 0.3 用例 2/3/4/5）',
    isHappyPath: false,
  },
  {
    scenario: 'failed',
    stage: 'poll',
    terminal: 'failed',
    wire: { code: 'internal_error', message: '厂商内部错误' },
    durationScale: 1,
    description: '异步终态：厂商内部错误（归一为 PROVIDER_ERROR）',
    isHappyPath: false,
  },
  {
    scenario: 'unavailable',
    stage: 'poll',
    terminal: 'failed',
    wire: { code: 'service_unavailable', message: '服务繁忙，请稍后重试' },
    durationScale: 1,
    description: '异步终态：厂商不可用（可重试，对应 0.3 用例 9 的邻近场景）',
    isHappyPath: false,
  },
  {
    scenario: 'timeout',
    stage: 'poll',
    // 刻意**不设终态** —— 永远停在 running，用来验证调用方的本地超时路径
    wire: {},
    durationScale: 1,
    description: '永不终态：用于验证本地超时与兜底（对应 0.3 用例 10）',
    isHappyPath: false,
  },
  {
    scenario: 'ratelimited',
    stage: 'submit',
    wire: { code: 'too_many_requests', message: '请求过于频繁' },
    durationScale: 1,
    description: '**同步**拒绝：限流 429（对应 0.3 用例 9；须确认契约是否要补 4xx）',
    isHappyPath: false,
  },
  {
    scenario: 'invalid',
    stage: 'submit',
    wire: { code: 'invalid_argument', message: '参数不合法' },
    durationScale: 1,
    description: '**同步**拒绝：参数非法（对应 0.3 用例 6/7）',
    isHappyPath: false,
  },
  {
    scenario: 'slow',
    stage: 'none',
    wire: {},
    durationScale: 10,
    description: '正常成功但耗时 ×10，用于验证进度条与超时体验',
    isHappyPath: true,
  },
];

// 键类型刻意是 string 而非 StubScenario：查表时要接受「任意用户输入」，
// 查不到回落 ok，而不是被迫在调用处做类型断言。
const BY_NAME = new Map<string, ScenarioSpec>(STUB_SCENARIOS.map((s) => [s.scenario, s]));

export function findScenario(name: string): ScenarioSpec | undefined {
  return BY_NAME.get(name);
}

/** 标记形如 `[stub:blocked]`；大小写不敏感，便于手输 */
const MARKER = /\[stub:([a-z_]+)\]/i;

/**
 * 从 prompt 里解析场景。未标记或标记无法识别时回落 `ok`。
 *
 * 无法识别时**不抛错**：这个标记只服务于本地联调，
 * 一个拼错的标记不应该让整个提交失败 —— 那会把调试工具变成故障源。
 */
export function parseScenario(prompt: string): ScenarioSpec {
  const matched = MARKER.exec(prompt ?? '');
  if (!matched) return BY_NAME.get('ok') as ScenarioSpec;
  return BY_NAME.get(matched[1].toLowerCase()) ?? (BY_NAME.get('ok') as ScenarioSpec);
}

interface StubJob {
  id: string;
  input: SubmitInput;
  startedAt: number;
  status: ProviderJobStatus;
  plannedDurationMs: number;
  scenario: ScenarioSpec;
  terminal?: PlatformFailure;
}

function isTerminal(status: ProviderJobStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'blocked';
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
  /**
   * 0–1，随机失败率。
   *
   * ⚠️ 默认 0，且**只在压测/长稳场景下才该调大** ——
   *    一旦非 0，测试就不再确定，也就没法用来断言。
   *    按需复现某条失败路径请用 `[stub:<场景>]` 标记，不要用这个。
   */
  failRate?: number;
  /** 0–1，随机拦截率。同上：默认 0，确定性优先 */
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
    const scenario = parseScenario(input.prompt);

    // 同步阶段的拒绝：**不创建任务**，直接抛。
    // 这正是执行包 §5 要求区分的那条路径 —— 走这里 → 契约要补 HTTP 4xx。
    if (scenario.stage === 'submit') {
      const failure = normalizeError(scenario.wire, { context: 'submit' });
      throw Object.assign(new Error(failure.message), { platformFailure: failure });
    }

    this.seq += 1;
    const id = `stub_${Date.now().toString(36)}_${this.seq}`;
    this.jobs.set(id, {
      id,
      input,
      startedAt: Date.now(),
      status: 'queued',
      plannedDurationMs: this.opts.durationMs * scenario.durationScale,
      scenario,
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

    // ⚠️ 终态必须先判、且必须早于下面的耗时判断。
    //    原先时间判断在前，导致 `cancel()` 之后的一段时间里 poll 仍报 `queued`
    //    （要等到走完 15% 的模拟时长才会读到那个 failed）。这是写测试时才发现的。
    if (isTerminal(job.status)) return this.terminalResult(job);

    const elapsed = Date.now() - job.startedAt;
    // `plannedDurationMs <= 0` 表示「已完成」：直接按 ratio=1 结算。
    // 不能写成 `elapsed / Math.max(1, planned)` —— 那样在同一毫秒内 elapsed=0 → ratio=0，
    // 仍会被判成 queued，于是 `durationMs: 0` 得不到「立即终态」，
    // 而这个语义正是测试与本地联调需要的。
    const ratio = job.plannedDurationMs <= 0 ? 1 : Math.min(1, elapsed / job.plannedDurationMs);

    // timeout 场景刻意永不结算：停在 running，把超时判定交给调用方
    if (job.scenario.scenario === 'timeout') {
      return { status: ratio < 0.15 ? 'queued' : 'running', progress: Math.min(95, Math.round(ratio * 95)) };
    }

    if (ratio < 0.15) return { status: 'queued', progress: Math.round(ratio * 30) };
    if (ratio < 1) {
      job.status = 'running';
      return { status: 'running', progress: Math.max(5, Math.round(ratio * 100)) };
    }

    if (job.scenario.terminal) {
      // 按标记确定的失败：走真实归一逻辑，不写死平台码
      job.status = job.scenario.terminal;
      job.terminal = normalizeError(job.scenario.wire, { context: 'poll' });
    } else {
      // 兜底：仅在显式调大随机率时才会命中（默认两个率都是 0，不会走到这里）
      const roll = Math.random();
      if (roll < this.opts.blockRate) {
        job.status = 'blocked';
        job.terminal = normalizeError({ code: 'content_policy_violation', message: '内容审核未通过（随机注入）' }, {});
      } else if (roll < this.opts.blockRate + this.opts.failRate) {
        job.status = 'failed';
        job.terminal = normalizeError({ code: 'internal_error', message: '厂商内部错误（随机注入）' }, {});
      } else {
        job.status = 'succeeded';
      }
    }

    return this.terminalResult(job);
  }

  /** 把终态组装成 PollResult（成功给产物，失败给归一后的 failure） */
  private terminalResult(job: StubJob): PollResult {
    if (job.status === 'succeeded') {
      const isVideo =
        job.input.capability === 'img2video' ||
        job.input.capability === 'txt2video' ||
        job.input.capability === 'audio';
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
        raw: { stub: true, scenario: job.scenario.scenario, modelKey: job.input.modelKey, seed: job.input.seed },
      };
    }

    return {
      status: job.status,
      progress: 100,
      failure: job.terminal,
      raw: { stub: true, scenario: job.scenario.scenario },
    };
  }

  async cancel(providerJobId: string): Promise<{ cancelled: boolean }> {
    const job = this.jobs.get(providerJobId);
    if (!job) return { cancelled: false };
    if (job.status === 'queued' || job.status === 'running') {
      job.status = 'failed';
      // ⚠️ 已知缺陷（已记入缺口 G15）：平台状态机没有 `cancelled` 终态，
      //    所以「用户取消」只能伪装成 failed。providerCode 里的 `user_cancelled`
      //    是唯一的区分依据。要修就得动契约的状态枚举，属 Sprint1 决策。
      job.terminal = normalizeError({ code: 'user_cancelled', message: '用户取消' }, {});
      return { cancelled: true };
    }
    return { cancelled: false };
  }

  normalize(input: unknown): PlatformFailure {
    return normalizeError(input);
  }
}
