/**
 * 连通性自测（`npm run provider:check` 与 `POST /v1/provider/ping` 共用同一实现）
 *
 * 为什么要抽成共享模块而不是各写一份：
 *   自测逻辑一旦有两份，就会出现「CLI 说通了、接口说没通」这类无法判断谁对的情况 ——
 *   而这条自测恰恰是用来判定「Key 是否可用」的依据，不能有歧义。
 *
 * 自测的判定标准（刻意的严格）：
 *   - 必须走完 submit → poll 到**终态**，只测「接口能否 ping 通」不足以证明 Key 可用
 *   - 「提交成功但没有产物」视为失败（有些厂商缺额度时正是这样返回）
 *   - 审核拦截是**真实终态**，如实报告而不是当成连通性失败
 */

import { resolveProvider } from './registry';
import { describeFailure } from './errors';
import type { PlatformFailure } from './types';

export interface PingStep {
  step: 'adapter' | 'submit' | 'poll' | 'error';
  ok: boolean;
  detail: string;
}

export interface PingResult {
  ok: boolean;
  usingStub: boolean;
  elapsedMs: number;
  steps: PingStep[];
  failure?: PlatformFailure;
  /** stub 结果不代表真实 Provider 行为，必须显式标记 */
  mockResult: boolean;
}

/** 默认探针提示词：刻意是一句与业务无关的最小输入 */
const DEFAULT_PROBE_PROMPT = 'connectivity probe: a single grey square on white background';

export interface PingOptions {
  /**
   * 覆盖探针提示词。
   *
   * ⚠️ **只在 stub 下允许生效** —— 判断由调用方（HTTP handler / CLI）负责，
   *    因为「该不该允许」是调用场景的属性，不是自测逻辑的属性。
   *    真实 Provider 下这个参数等于「花真钱跑一个任意提示词」，
   *    不该开在自检接口上。
   *
   * 它的用途是让前端的失败态 UI 可被驱动：把 `[stub:blocked]` 之类
   * 嵌进提示词，就能从真实 HTTP 入口复现「内容被拦截」这条链路。
   */
  prompt?: string;
}

export async function providerPing(
  timeoutMs = 60000,
  pollIntervalMs = 1000,
  options: PingOptions = {},
): Promise<PingResult> {
  const { adapter, usingStub } = resolveProvider();
  const steps: PingStep[] = [];
  const t0 = Date.now();

  steps.push(
    usingStub
      ? { step: 'adapter', ok: true, detail: '降级到 stub（未配置 Key）—— 以下结果不代表真实 Provider 行为' }
      : { step: 'adapter', ok: true, detail: `使用 ${adapter.id}（${adapter.displayName}）` },
  );

  try {
    const submitted = await adapter.submit({
      capability: 'txt2img',
      modelKey: 'txt2img-p0',
      prompt: options.prompt ?? DEFAULT_PROBE_PROMPT,
      seed: 42,
    });
    steps.push({ step: 'submit', ok: true, detail: `受理成功，providerJobId=${submitted.providerJobId}` });

    const deadline = Date.now() + timeoutMs;
    let last = 'queued';

    while (Date.now() < deadline) {
      const polled = await adapter.poll(submitted.providerJobId);
      last = `${polled.status} ${polled.progress}%`;

      if (polled.status === 'succeeded') {
        const urls = (polled.artifacts ?? []).map((a) => a.url).join(', ');
        if (!urls) {
          // 「成功但无产物」在真实厂商里常对应额度耗尽/权限不足，必须判失败
          steps.push({ step: 'poll', ok: false, detail: '返回 succeeded 但无产物地址（可能是额度或权限问题）' });
          return { ok: false, usingStub, elapsedMs: Date.now() - t0, steps, mockResult: usingStub };
        }
        steps.push({ step: 'poll', ok: true, detail: `succeeded，产物：${urls}` });
        return { ok: true, usingStub, elapsedMs: Date.now() - t0, steps, mockResult: usingStub };
      }

      if (polled.status === 'failed' || polled.status === 'blocked') {
        const failure = polled.failure;
        steps.push({
          step: 'poll',
          ok: false,
          detail: failure
            ? `${describeFailure(failure)}${polled.status === 'blocked' ? '（内容审核拦截，属真实终态）' : ''}`
            : `终态 ${polled.status} 但未提供失败原因`,
        });
        return { ok: false, usingStub, elapsedMs: Date.now() - t0, steps, failure, mockResult: usingStub };
      }

      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    const failure: PlatformFailure = {
      code: 'PROVIDER_TIMEOUT',
      providerCode: '(local-timeout)',
      message: `本地等待超过 ${timeoutMs}ms，最后状态 ${last}`,
      billable: false,
      retryable: true,
      providerCharged: false,
    };
    steps.push({ step: 'poll', ok: false, detail: describeFailure(failure) });
    return { ok: false, usingStub, elapsedMs: Date.now() - t0, steps, failure, mockResult: usingStub };
  } catch (err) {
    const failure =
      (err as { platformFailure?: PlatformFailure }).platformFailure ??
      adapter.normalize(err instanceof Error ? err.message : err);
    steps.push({ step: 'error', ok: false, detail: describeFailure(failure) });
    return { ok: false, usingStub, elapsedMs: Date.now() - t0, steps, failure, mockResult: usingStub };
  }
}
