import { describe, expect, it } from 'vitest';
import { STUB_SCENARIOS, StubProvider, parseScenario } from '../server/providers/stub';
import { normalizeError } from '../server/providers/errors';
import type { PlatformErrorCode, SubmitInput } from '../server/providers/types';

/**
 * Stub Provider 测试。
 *
 * 这个文件守的是**「没有 Provider Key 时能不能继续把错误路径做对」**这件事。
 *
 * 2026-10-12 之前，stub 只能靠 `STUB_FAIL_RATE` 随机出故障，因此：
 *   · 想验「审核拦截」得走运；
 *   · 写不了断言（随机 → flaky → 最终被跳过）；
 *   · 更要命的是——**同步拒绝与异步终态分不出来**，而这正是执行包 §5
 *     要求确认的那件事（前者要改契约，后者不用）。
 * 升级为按 `[stub:<场景>]` 驱动后，这些路径才第一次变得可断言。
 */

const input = (prompt: string, over: Partial<SubmitInput> = {}): SubmitInput => ({
  capability: 'txt2img',
  modelKey: 'txt2img-p0',
  prompt,
  seed: 20261012,
  ...over,
});

/** durationMs=0 → 首次 poll 即到终态，测试不必等真实时间 */
const instant = () => new StubProvider({ durationMs: 0 });

/* ------------------------------------------------------------------ 解析 */

describe('parseScenario · 触发值解析', () => {
  it('无标记时走正常成功', () => {
    expect(parseScenario('海岸线日出，电影级长镜头').scenario).toBe('ok');
  });

  for (const s of STUB_SCENARIOS) {
    it(`[stub:${s.scenario}] → ${s.scenario}`, () => {
      expect(parseScenario(`海岸线日出 [stub:${s.scenario}]`).scenario).toBe(s.scenario);
    });
  }

  it('大小写不敏感（便于手输）', () => {
    expect(parseScenario('[STUB:BLOCKED] x').scenario).toBe('blocked');
  });

  it('标记之外的文本不影响解析', () => {
    expect(parseScenario('一只猫 [stub:slow] 在海边').scenario).toBe('slow');
  });

  it('无法识别的标记回落 ok，而不是抛错', () => {
    // 一个拼错的调试标记不该让整个提交失败 —— 那会把调试工具本身变成故障源
    expect(parseScenario('[stub:not_a_real_scenario] x').scenario).toBe('ok');
  });

  it('普通文本里出现「stub」字样不会误触发（必须带方括号与冒号）', () => {
    expect(parseScenario('关于 stub 的说明文档').scenario).toBe('ok');
    expect(parseScenario('stub:blocked 没有方括号').scenario).toBe('ok');
  });

  it('空字符串不炸', () => {
    expect(parseScenario('').scenario).toBe('ok');
  });
});

/* ------------------------------------------------------------------ 覆盖度 */

describe('STUB_SCENARIOS · 覆盖度（否则某些分支永远测不到）', () => {
  it('场景名唯一', () => {
    const names = STUB_SCENARIOS.map((s) => s.scenario);
    expect(new Set(names).size).toBe(names.length);
  });

  it('每个场景都有可读说明', () => {
    for (const s of STUB_SCENARIOS) {
      expect(s.description.length).toBeGreaterThan(6);
    }
  });

  it('厂商侧的 5 个平台错误码都有场景能产出，且走的是真实归一逻辑', () => {
    const produced = new Set<PlatformErrorCode>();
    for (const s of STUB_SCENARIOS) {
      if (s.stage === 'submit' || s.terminal) {
        produced.add(normalizeError(s.wire, { context: s.stage }).code);
      }
    }

    const expected: PlatformErrorCode[] = [
      'CONTENT_BLOCKED_BY_PROVIDER',
      'RATE_LIMITED',
      'INVALID_ARGUMENT',
      'PROVIDER_ERROR',
      'PROVIDER_UNAVAILABLE',
    ];
    for (const code of expected) {
      expect(produced.has(code), `没有场景能产出 ${code}`).toBe(true);
    }

    // PROVIDER_TIMEOUT 刻意不在此列：**厂商超时不会主动告诉我们**，
    // 只能由调用方等不下去后本地判定。所以 stub 的 timeout 场景停在 running，
    // 把超时判定权完整交给调用方 —— 这是对现实的忠实，不是遗漏。
    expect(produced.has('PROVIDER_TIMEOUT')).toBe(false);
  });

  it('同步拒绝与异步终态都有覆盖（执行包 §5 的核心判据）', () => {
    const submitStage = STUB_SCENARIOS.filter((s) => s.stage === 'submit');
    const pollStage = STUB_SCENARIOS.filter((s) => s.terminal);
    expect(submitStage.length).toBeGreaterThanOrEqual(2);
    expect(pollStage.length).toBeGreaterThanOrEqual(3);
  });
});

/* -------------------------------------------------- 同步拒绝 vs 异步终态 */

describe('StubProvider · 同步拒绝 vs 异步终态', () => {
  it('[stub:ratelimited] 在 **submit 阶段**抛错，未创建任务', async () => {
    const p = instant();
    await expect(p.submit(input('[stub:ratelimited] 海岸线日出'))).rejects.toMatchObject({
      platformFailure: expect.objectContaining({ code: 'RATE_LIMITED' }),
    });
  });

  it('[stub:invalid] 在 **submit 阶段**抛错，未创建任务', async () => {
    const p = instant();
    await expect(p.submit(input('[stub:invalid] 海岸线日出'))).rejects.toMatchObject({
      platformFailure: expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    });
  });

  it('[stub:blocked] 提交会成功，拦截发生在 **异步终态**', async () => {
    const p = instant();
    const submitted = await p.submit(input('[stub:blocked] 海岸线日出'));
    expect(submitted.providerJobId).toBeTruthy();

    const polled = await p.poll(submitted.providerJobId);
    expect(polled.status).toBe('blocked');
    expect(polled.failure?.code).toBe('CONTENT_BLOCKED_BY_PROVIDER');
  });

  it('两类失败可用 stage 区分（这是「契约要不要改」的判据）', () => {
    // 同步拒绝 → 契约需补 HTTP 4xx；异步终态 → 走 job.errorCode，契约不用改。
    // 两者的「结果」都是失败，靠别的东西判断不出来 —— 所以 stage 必须显式建模。
    const syncNames = STUB_SCENARIOS.filter((s) => s.stage === 'submit').map((s) => s.scenario);
    const asyncNames = STUB_SCENARIOS.filter((s) => s.terminal).map((s) => s.scenario);
    expect(syncNames.sort()).toEqual(['invalid', 'ratelimited']);
    expect(asyncNames.sort()).toEqual(['blocked', 'failed', 'unavailable']);
  });
});

/* ------------------------------------------------------------------ 各终态 */

describe('StubProvider · 各场景的终态', () => {
  const run = async (marker: string) => {
    const p = instant();
    const submitted = await p.submit(input(`${marker} 海岸线日出`));
    return p.poll(submitted.providerJobId);
  };

  it('无标记 → 成功，产物用 stub:// 前缀（避免被当成真实资源）', async () => {
    const r = await run('海岸线日出');
    expect(r.status).toBe('succeeded');
    expect(r.progress).toBe(100);
    expect(r.artifacts?.[0]?.url).toMatch(/^stub:\/\/artifact\//);
    expect(r.artifacts?.[0]?.url.endsWith('.png')).toBe(true);
  });

  it('img2video → 产物扩展名与时长正确', async () => {
    const p = instant();
    const submitted = await p.submit(
      input('海岸线日出', { capability: 'img2video', durationSeconds: 8 }),
    );
    const r = await p.poll(submitted.providerJobId);
    expect(r.artifacts?.[0]?.url.endsWith('.mp4')).toBe(true);
    expect(r.artifacts?.[0]?.durationMs).toBe(8000);
  });

  it('[stub:failed] → PROVIDER_ERROR 且不可重试', async () => {
    const r = await run('[stub:failed]');
    expect(r.status).toBe('failed');
    expect(r.failure?.code).toBe('PROVIDER_ERROR');
    expect(r.failure?.retryable).toBe(false);
  });

  it('[stub:unavailable] → PROVIDER_UNAVAILABLE 且可重试', async () => {
    const r = await run('[stub:unavailable]');
    expect(r.failure?.code).toBe('PROVIDER_UNAVAILABLE');
    expect(r.failure?.retryable).toBe(true);
  });

  it('所有失败都不计费（平台口径：只有成功才计费）', async () => {
    for (const marker of ['[stub:blocked]', '[stub:failed]', '[stub:unavailable]']) {
      const r = await run(marker);
      expect(r.failure?.billable, `${marker} 竟然计费`).toBe(false);
    }
  });

  it('[stub:timeout] 永不终态（把超时判定交给调用方）', async () => {
    const p = instant();
    const submitted = await p.submit(input('[stub:timeout] 海岸线日出'));
    for (let i = 0; i < 5; i += 1) {
      const r = await p.poll(submitted.providerJobId);
      expect(['queued', 'running']).toContain(r.status);
      expect(r.failure).toBeUndefined();
    }
  });

  it('未知 jobId → 明确的失败，而不是静默成功', async () => {
    const p = instant();
    const r = await p.poll('stub_does_not_exist');
    expect(r.status).toBe('failed');
    expect(r.failure).toBeDefined();
  });
});

/* ------------------------------------------------------------------ 确定性 */

describe('确定性 · 本次升级的核心诉求', () => {
  it('同一输入重复 12 次得到完全相同的结论（默认不再依赖随机数）', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 12; i += 1) {
      const p = instant();
      const submitted = await p.submit(input('海岸线日出'));
      const r = await p.poll(submitted.providerJobId);
      seen.add(`${r.status}:${r.progress}:${r.artifacts?.[0]?.url?.split('/').pop()?.split('.')[1]}`);
    }
    expect(seen.size).toBe(1);
  });

  it('标注了失败场景时重复 12 次都稳定失败（旧实现这里是 flaky 的）', async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 12; i += 1) {
      const p = instant();
      const submitted = await p.submit(input('[stub:blocked] 海岸线日出'));
      const r = await p.poll(submitted.providerJobId);
      codes.add(`${r.status}:${r.failure?.code}`);
    }
    expect(codes.size).toBe(1);
    expect([...codes][0]).toBe('blocked:CONTENT_BLOCKED_BY_PROVIDER');
  });
});

/* ------------------------------------------------------------------ 取消 */

describe('StubProvider · cancel', () => {
  it('取消排队中的任务后，poll **立即**返回终态（不会先报 queued）', async () => {
    // 这条守的是一个真实缺陷：原先 poll 的时间判断在终态判断之前，
    // 于是 cancel 之后的一段时间里 poll 仍报 queued —— 要等走完 15% 的模拟时长才读到 failed。
    const p = new StubProvider({ durationMs: 60000 });
    const submitted = await p.submit(input('海岸线日出'));

    expect((await p.cancel(submitted.providerJobId)).cancelled).toBe(true);

    const r = await p.poll(submitted.providerJobId);
    expect(r.status).toBe('failed');
    // 平台状态机没有 cancelled 终态（缺口 G15），providerCode 是唯一的区分依据
    expect(r.failure?.providerCode).toBe('user_cancelled');
  });

  it('已完成的任务无法取消', async () => {
    const p = instant();
    const submitted = await p.submit(input('海岸线日出'));
    await p.poll(submitted.providerJobId);
    expect((await p.cancel(submitted.providerJobId)).cancelled).toBe(false);
  });

  it('未知 jobId 取消返回 false，不抛错', async () => {
    expect((await instant().cancel('nope')).cancelled).toBe(false);
  });
});

/* ------------------------------------------------------------------ 耗时 */

describe('StubProvider · 耗时倍率', () => {
  it('[stub:slow] 的模拟耗时 ×10', async () => {
    // durationMs=200：正常任务 200ms 完成，slow 需要 2000ms
    const p = new StubProvider({ durationMs: 200 });
    const slow = await p.submit(input('[stub:slow] 海岸线日出'));
    const normal = await p.submit(input('海岸线日出'));

    await new Promise((r) => setTimeout(r, 500));

    expect((await p.poll(normal.providerJobId)).status).toBe('succeeded');
    expect((await p.poll(slow.providerJobId)).status).not.toBe('succeeded');
  });
});
