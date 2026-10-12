import { describe, expect, it } from 'vitest';
import { AUDIT_CASES, findCase, readinessOf } from '../server/audit/cases';
import {
  observationFromFailure,
  redactValue,
  renderMarkdownReport,
  verdictOf,
  type AuditMeta,
  type AuditObservation,
} from '../server/audit/report';

/**
 * 审核实测执行器测试。
 *
 * 重点锁三件事，因为这三件事错了都不会有任何报错、只会给出错误结论：
 *   1. 用例表必须与执行包 §5 一致 —— 少一条或期望码记错，这张实测表就白跑了
 *   2. 脱敏必须真的摘得掉 —— 报告是要贴进文档发给别人的
 *   3. **同步 vs 异步拦截的判据** —— 两者对契约的影响完全相反
 */

const META: AuditMeta = {
  provider: 'generic-http',
  model: 'txt2img-p0',
  baseUrl: 'https://api.example.com',
  ranAt: '2026-10-12T00:00:00.000Z',
  concurrency: 8,
};

const noEnv = (): string | undefined => undefined;
const withEnv =
  (map: Record<string, string>) =>
  (k: string): string | undefined =>
    map[k];

describe('AUDIT_CASES · 与执行包 §5 的一致性', () => {
  it('恰好 10 条，且 id 1–10 连续唯一', () => {
    expect(AUDIT_CASES.length).toBe(10);
    expect(AUDIT_CASES.map((c) => c.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('每条都有名称、输入要点与期望说明（便于直接渲染进报告）', () => {
    for (const c of AUDIT_CASES) {
      expect(c.name).toBeTruthy();
      expect(c.intent.length).toBeGreaterThan(3);
      expect(c.expect.length).toBeGreaterThan(3);
    }
  });

  it('期望的平台错误码与执行包 §5 的回填表一致', () => {
    // 把文档里的映射硬编码在这里。若有人「顺手」改了用例期望，
    // 这条会红 —— 因为它等于偷偷改了 0.3 的验收口径。
    expect(findCase(1)?.expectation).toBeNull(); // 正常通过
    expect(findCase(2)?.expectation).toBe('CONTENT_BLOCKED_BY_PROVIDER');
    expect(findCase(3)?.expectation).toBe('ANY'); // 擦边：拦不拦都是结论
    expect(findCase(4)?.expectation).toBe('ANY');
    expect(findCase(5)?.expectation).toBe('ANY');
    expect(findCase(6)?.expectation).toBe('INVALID_ARGUMENT');
    expect(findCase(7)?.expectation).toBe('ANY');
    expect(findCase(8)?.expectation).toBe('ANY');
    expect(findCase(9)?.expectation).toBe('RATE_LIMITED');
    expect(findCase(10)?.expectation).toBe('PROVIDER_TIMEOUT');
  });

  it('涉及违规/肖像/商标的用例必须要求操作者提供素材（脚本不预置违规内容）', () => {
    const needInput = AUDIT_CASES.filter((c) => c.requiresOperatorInput).map((c) => c.id);
    expect(needInput).toEqual([2, 3, 4, 5, 8]);
    for (const c of AUDIT_CASES.filter((x) => x.requiresOperatorInput)) {
      expect(c.inputEnv).toMatch(/^AUDIT_/);
    }
  });

  it('用例 9/10 标记为特殊执行，不能被当成普通提交', () => {
    expect(findCase(9)?.special).toBe('concurrency');
    expect(findCase(10)?.special).toBe('timeout');
  });

  it('未提供素材时，操作者输入的去向必须为空（逐个字段核对，不靠整体非空判断）', () => {
    // 逐个用例核对「操作者输入落在哪个字段」，比笼统断言「整体为空」精确：
    // 用例 8 的 prompt 是中性的基线文本，只有 negativePrompt 属于操作者输入，
    // 若整体判断会把它误判为泄漏。
    expect(findCase(2)!.build(noEnv).prompt).toBe('');
    expect(findCase(3)!.build(noEnv).prompt).toBe('');
    expect(findCase(5)!.build(noEnv).prompt).toBe('');
    expect(findCase(8)!.build(noEnv).negativePrompt).toBe('');
    expect(findCase(4)!.build(noEnv).referenceUrls).toEqual([]);
  });
});

describe('readinessOf · 缺素材时跳过，而不是伪造输入', () => {
  it('不需要素材的用例始终就绪', () => {
    for (const c of AUDIT_CASES.filter((x) => !x.requiresOperatorInput)) {
      expect(readinessOf(c, noEnv).ready).toBe(true);
    }
  });

  it('未提供素材时给出「设哪个变量」的具体指引', () => {
    const r = readinessOf(findCase(2)!, noEnv);
    expect(r.ready).toBe(false);
    if (!r.ready) {
      expect(r.reason).toContain('AUDIT_CASE2_PROMPT');
      // 必须解释为什么脚本不自己填：否则使用者会以为这是没写完
      expect(r.reason).toContain('刻意不预置');
    }
  });

  it('只有空白字符也算未提供', () => {
    expect(readinessOf(findCase(2)!, withEnv({ AUDIT_CASE2_PROMPT: '   ' })).ready).toBe(false);
  });

  it('提供了素材后即就绪', () => {
    expect(readinessOf(findCase(4)!, withEnv({ AUDIT_CASE4_REF_URL: 'https://x/y.png' })).ready).toBe(true);
  });
});

/**
 * 假密钥在**运行时拼接**，文件里不留任何「密钥形态」的字面量。
 *
 * 为什么要这么绕：`tests/secrets.test.ts` 的「不得硬编码密钥」护栏现在也扫 `tests/`。
 * 若这里为了测脱敏而写一个像真密钥的字面量，就会出现
 * 「**测脱敏的用例自己被密钥护栏拦住**」的自相矛盾。
 * 拼接构造两头都满足：既是密钥形态（能测到脱敏路径），又不在源码里留下它。
 */
const FAKE_KEY = ['sk', 'THISISNOTAREALKEYFIXTURE00000000'].join('-');
const FAKE_BEARER = 'NOTAREALTOKEN0000000000000000';

describe('redactValue · 报告是要发给别人的', () => {
  it('摘掉密钥形态的字符串（即使字段名看起来无害）', () => {
    expect(redactValue(`token ${FAKE_KEY} here`)).not.toContain(FAKE_KEY);
    expect(redactValue(`Authorization: Bearer ${FAKE_BEARER}`)).not.toContain(FAKE_BEARER);
    // 字段名无害时也必须摘 —— KEY_LIKE 这条路径正是为此存在
    expect(JSON.stringify(redactValue({ note: FAKE_KEY }))).not.toContain(FAKE_KEY);
  });

  it('键名敏感时整值替换', () => {
    const out = redactValue({ apiKey: 'whatever', accessToken: 'x', signature: 'y', normal: 'z' }) as Record<
      string,
      unknown
    >;
    expect(out.apiKey).toBe('[已脱敏]');
    expect(out.accessToken).toBe('[已脱敏]');
    expect(out.signature).toBe('[已脱敏]');
    expect(out.normal).toBe('z');
  });

  it('超长字符串被截断并注明原长（避免一次超长返回撑爆报告）', () => {
    const out = redactValue('x'.repeat(5000)) as string;
    expect(out.length).toBeLessThan(700);
    expect(out).toContain('原长 5000');
  });

  it('长数组只保留前 8 项并注明余量', () => {
    const out = redactValue(Array.from({ length: 20 }, (_, i) => i)) as unknown[];
    expect(out.length).toBe(9); // 8 + 提示项
    expect(String(out[8])).toContain('另有 12 项');
  });

  it('极深嵌套不抛错', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 30; i += 1) deep = { nested: deep };
    expect(() => redactValue(deep)).not.toThrow();
  });
});

describe('verdictOf · 四态判读', () => {
  const ok: AuditObservation = { caseId: 1, outcome: 'succeeded', platformCode: null };

  it('期望成功且成功 → 通过', () => {
    expect(verdictOf(findCase(1)!, ok)).toBe('通过');
  });

  it('期望成功但失败 → 偏离', () => {
    expect(verdictOf(findCase(1)!, { caseId: 1, outcome: 'failed', platformCode: 'PROVIDER_ERROR' })).toBe('偏离');
  });

  it('期望特定码且命中 → 通过；未命中 → 偏离', () => {
    expect(verdictOf(findCase(6)!, { caseId: 6, outcome: 'failed', platformCode: 'INVALID_ARGUMENT' })).toBe('通过');
    expect(verdictOf(findCase(6)!, { caseId: 6, outcome: 'failed', platformCode: 'PROVIDER_ERROR' })).toBe('偏离');
  });

  it('期望 ANY（摸边界）无论拦没拦都记为「记录」，不判通过/失败', () => {
    // 这是刻意的第三态：用例 3/5/7/8 的目的是摸清边界而不是验证断言。
    // 若强行判成通过/失败，会逼着人去「调」测试来迎合预期 —— 那是自欺。
    expect(verdictOf(findCase(3)!, { caseId: 3, outcome: 'blocked', platformCode: 'CONTENT_BLOCKED_BY_PROVIDER' })).toBe('记录');
    expect(verdictOf(findCase(3)!, { caseId: 3, outcome: 'succeeded', platformCode: null })).toBe('记录');
  });

  it('跳过与未执行都判为「未执行」', () => {
    expect(verdictOf(findCase(2)!, { caseId: 2, outcome: 'skipped' })).toBe('未执行');
    expect(verdictOf(findCase(2)!, { caseId: 2, outcome: 'not-run' })).toBe('未执行');
  });
});

describe('renderMarkdownReport · 可直接替换执行包 §5 的空表', () => {
  const blockedFail = (caseId: number, stage: 'submit' | 'poll'): AuditObservation => ({
    caseId,
    outcome: 'blocked',
    stage,
    platformCode: 'CONTENT_BLOCKED_BY_PROVIDER',
    providerCode: 'content_policy_violation',
    billed: false,
    // 值刻意不写成密钥形态：这里测的是「字段名敏感即整值替换」这条路径
    raw: { code: 'content_policy_violation', key: 'MUST-NOT-SURVIVE-REDACTION' },
  });

  const base: AuditObservation[] = [
    { caseId: 1, outcome: 'succeeded', platformCode: null, elapsedMs: 4200, billed: true, raw: { id: 'job_1' } },
    ...AUDIT_CASES.filter((c) => c.requiresOperatorInput).map((c) => ({
      caseId: c.id,
      outcome: 'skipped' as const,
      note: '未提供测试素材',
    })),
  ];

  it('表头与用例行数正确（10 条用例 + 8 列）', () => {
    const md = renderMarkdownReport(AUDIT_CASES, base, META);
    expect(md).toContain('| # | 用例 | 输入要点 | 期望了解 | 实际结果 | 判读 | 原始返回 | 是否计费 |');
    for (const c of AUDIT_CASES) expect(md).toContain(`| ${c.id} | ${c.name} |`);
  });

  it('报告里不出现任何明文密钥（原始返回体已脱敏）', () => {
    const md = renderMarkdownReport(AUDIT_CASES, [...base, blockedFail(2, 'poll')], META);
    expect(md).not.toContain('MUST-NOT-SURVIVE-REDACTION');
  });

  it('调用方忘记脱敏时，报告自己兜住（纵深防御）', () => {
    // 这条对应一个真实缺陷：第一版只有 observationFromFailure 会脱敏，
    // 而 renderMarkdownReport 直接信任传入的 raw。任何调用方漏一次，密钥就永久进了文档。
    const unredacted: AuditObservation = {
      caseId: 1,
      outcome: 'succeeded',
      platformCode: null,
      raw: { artifacts: [{ url: 'https://x/y.png' }], debug: FAKE_KEY },
    };
    const md = renderMarkdownReport(AUDIT_CASES, [unredacted], META);
    expect(md).not.toContain(FAKE_KEY);
  });

  it('拦截发生在异步终态 → 明确写出「契约无需修正」', () => {
    const md = renderMarkdownReport(AUDIT_CASES, [...base, blockedFail(2, 'poll')], META);
    expect(md).toContain('异步阶段拦截');
    expect(md).toContain('契约无需修正');
  });

  it('拦截发生在同步提交阶段 → 明确要求修正契约', () => {
    // 这条守住的正是 report.ts 第一版的 bug：用 outcome 判阶段会把结论判反，
    // 而判反的后果是该改的契约没改。
    const md = renderMarkdownReport(AUDIT_CASES, [...base, blockedFail(2, 'submit')], META);
    expect(md).toContain('同步提交阶段就被拒绝');
    expect(md).toContain('契约需修正');
    expect(md).not.toContain('契约无需修正');
  });

  it('完全没观测到拦截 → 提示 DR-003 可能不成立（而不是含糊过去）', () => {
    const md = renderMarkdownReport(AUDIT_CASES, base, META);
    expect(md).toContain('未观测到任何拦截');
    expect(md).toContain('DR-003');
  });

  it('产出平台错误码回填建议表，且未观测到的情形标注清楚', () => {
    const md = renderMarkdownReport(AUDIT_CASES, base, META);
    expect(md).toContain('| 平台错误码 | 实测到的厂商情形 | 触发用例 | 积分处理 | 频率配额 |');
    expect(md).toContain('CONTENT_BLOCKED_BY_PROVIDER');
    expect(md).toContain('未观测到');
    // 建议必须带「人工复核」提示 —— 归一是启发式的，厂商换措辞就会失配
    expect(md).toContain('请人工复核');
  });
});

describe('observationFromFailure · 阶段与计费口径', () => {
  const failure = {
    code: 'CONTENT_BLOCKED_BY_PROVIDER' as const,
    providerCode: '1001',
    message: '被拦截',
    billable: false,
    retryable: false,
    providerCharged: true,
    raw: { code: 1001 },
  };

  it('stage 被透传（决定契约是否要改的判据）', () => {
    expect(observationFromFailure(2, failure, 100, 'submit').stage).toBe('submit');
    expect(observationFromFailure(2, failure, 100, 'poll').stage).toBe('poll');
  });

  it('拦截记为 blocked，且不计费但如实记录厂商已计费', () => {
    const o = observationFromFailure(2, failure, 100, 'poll');
    expect(o.outcome).toBe('blocked');
    expect(o.billed).toBe(false);
    expect(o.providerCharged).toBe(true);
  });

  it('原始返回体在建观测时即完成脱敏', () => {
    const o = observationFromFailure(
      2,
      { ...failure, raw: { apiKey: 'MUST-NOT-SURVIVE-REDACTION-2' } },
      100,
      'poll',
    );
    expect(JSON.stringify(o.raw)).not.toContain('MUST-NOT-SURVIVE-REDACTION-2');
  });
});
