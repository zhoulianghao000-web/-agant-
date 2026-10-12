/**
 * 审核口径实测的报告生成（纯函数，可单测）
 *
 * 与 `cases.ts` 分开的理由：用例表是「要测什么」，报告是「测出了什么」。
 * 混在一个文件里会让两者都无法独立演进 —— 加一条用例不该动到报告格式。
 *
 * 这里承担三件事：
 *   1. **脱敏**：原始返回体要贴进报告，必须先摘掉任何密钥形态的字符串
 *   2. **判读**：把观测结果与用例预期比对，给出「通过 / 偏离 / 记录」
 *   3. **回填建议**：直接产出 §5「产出要求」要的那张平台错误码映射表
 */

import type { PlatformErrorCode, PlatformFailure } from '../providers/types';
import type { AuditCase } from './cases';

export const REDACT_MARKER = '[已脱敏]';

/** 把观测结果压到报告里需要的形状 */
export interface AuditObservation {
  caseId: number;
  outcome: 'succeeded' | 'blocked' | 'failed' | 'skipped' | 'not-run';
  /**
   * 该结论是在哪个阶段拿到的。
   *
   * ⚠️ 必须单独字段，不能靠 `outcome` 推断 —— 「同步提交被拒」与「轮询到终态拦截」
   *    的 `outcome` 都是 `blocked`，但两者对契约的影响完全相反：
   *    前者要求把错误码提前到 HTTP 4xx，后者不用改契约。
   *    （这正是本文件第一版写错的地方：用 outcome 判阶段，会把结论判反。）
   */
  stage?: 'submit' | 'poll';
  /** 归一出的平台错误码；成功时为 null */
  platformCode?: PlatformErrorCode | null;
  providerCode?: string;
  message?: string;
  elapsedMs?: number;
  /** 是否向用户计费（平台口径：只有成功才计费） */
  billed?: boolean;
  /** 厂商是否已向我方计费 */
  providerCharged?: boolean;
  /** 原始返回体（已脱敏） */
  raw?: unknown;
  /** 备注：跳过原因、特殊执行说明等 */
  note?: string;
}

export type Verdict = '通过' | '偏离' | '记录' | '未执行';

/* ------------------------------------------------------------------ 脱敏 */

/**
 * 密钥形态的串。这里刻意保守：宁可比实际多摘一点。
 * 报告是要贴进文档、发给别人的，多摘一个无害，漏摘一个就是泄漏。
 */
const KEY_LIKE = /((?:sk|pk|ak|gho|ghp|ghs)-[A-Za-z0-9_-]{8,})|(?:Bearer\s+[A-Za-z0-9_\-.]+)/gi;

/** 单个字符串字段的展示上限，避免一次超长返回把报告撑爆 */
const MAX_STR = 600;

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[层级过深已省略]';
  if (typeof value === 'string') {
    const cleaned = value.replace(KEY_LIKE, REDACT_MARKER);
    return cleaned.length > MAX_STR ? `${cleaned.slice(0, MAX_STR)}…[截断，原长 ${cleaned.length}]` : cleaned;
  }
  if (Array.isArray(value)) {
    // 数组只留前 8 项：产物列表可能很长，但报告只需要看结构
    const head = value.slice(0, 8).map((v) => redactValue(v, depth + 1));
    return value.length > 8 ? [...head, `…[另有 ${value.length - 8} 项]`] : head;
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = /key|token|secret|authorization|signature/i.test(k) ? REDACT_MARKER : redactValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** 从 PlatformFailure 构造观测记录。`stage` 由调用方给出，决定契约是否需修正 */
export function observationFromFailure(
  caseId: number,
  failure: PlatformFailure,
  elapsedMs: number,
  stage: 'submit' | 'poll' = 'poll',
): AuditObservation {
  const isBlocked = failure.code === 'CONTENT_BLOCKED_BY_PROVIDER';
  return {
    caseId,
    outcome: isBlocked ? 'blocked' : 'failed',
    stage,
    platformCode: failure.code,
    providerCode: failure.providerCode,
    message: failure.message,
    elapsedMs,
    billed: failure.billable,
    providerCharged: failure.providerCharged,
    raw: redactValue(failure.raw),
  };
}

/* ------------------------------------------------------------------ 判读 */

/**
 * 观测 vs 预期。
 *
 * `记录` 是一个**必要的第三态**：用例 3/5/7/8 的目的是摸边界而不是验证某个断言，
 * 「拦了」和「没拦」都是有效结论。若强行判成通过/失败，
 * 就会逼着人去「调」测试来迎合预期 —— 那是自欺，而不是摸清了厂商行为。
 */
export function verdictOf(auditCase: AuditCase, obs: AuditObservation): Verdict {
  if (obs.outcome === 'skipped') return '未执行';
  if (obs.outcome === 'not-run') return '未执行';

  if (auditCase.expectation === 'ANY') return '记录';

  if (auditCase.expectation === null) {
    return obs.outcome === 'succeeded' ? '通过' : '偏离';
  }

  return obs.platformCode === auditCase.expectation ? '通过' : '偏离';
}

/* ------------------------------------------------------------------ 报告 */

export interface AuditMeta {
  provider: string;
  model: string;
  baseUrl: string;
  ranAt: string;
  /** 并发用例实际用的并发数 */
  concurrency: number;
}

const outcomeLabel = (o: AuditObservation): string => {
  switch (o.outcome) {
    case 'succeeded':
      return `成功${o.elapsedMs !== undefined ? `（${(o.elapsedMs / 1000).toFixed(1)}s）` : ''}`;
    case 'blocked':
      return '被审核拦截';
    case 'failed':
      return '失败';
    case 'skipped':
      return '跳过';
    default:
      return '未执行';
  }
};

const billingLabel = (o: AuditObservation): string => {
  if (o.outcome === 'skipped' || o.outcome === 'not-run') return '—';
  if (o.billed) return '是';
  if (o.providerCharged) return '否（但厂商已计费我方）';
  return '否';
};

function compactRaw(o: AuditObservation): string {
  if (o.outcome === 'skipped' || o.outcome === 'not-run') return '—';
  if (o.raw === undefined) return '—';

  // **在这里再脱一次敏，不信任调用方。**
  // 这条是被测试逼出来的：第一版只有 `observationFromFailure` 会脱敏，
  // 而 `renderMarkdownReport` 直接信任传入的 raw —— 任何调用方漏一次，
  // 密钥就永久写进了报告文档。报告是落到纸面上的最后一道关，必须自己保证。
  const text = JSON.stringify(redactValue(o.raw));
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

export function renderMarkdownReport(
  cases: readonly AuditCase[],
  observations: readonly AuditObservation[],
  meta: AuditMeta,
): string {
  const byId = new Map(observations.map((o) => [o.caseId, o]));
  const lines: string[] = [];

  lines.push('# 任务 0.3 · 审核口径实测报告');
  lines.push('');
  lines.push(`> 生成时间：${meta.ranAt}`);
  lines.push(`> Provider：\`${meta.provider}\` ｜ 模型：\`${meta.model}\``);
  lines.push(`> 基址：\`${meta.baseUrl}\` ｜ 并发用例档位：${meta.concurrency}`);
  lines.push('');
  lines.push('本报告由 `npm run provider:audit` 生成，可直接替换');
  lines.push('`阶段0-Provider接入执行包-v1.md` §5 的空表。原始返回体已脱敏。');
  lines.push('');

  lines.push('## 用例结果');
  lines.push('');
  lines.push('| # | 用例 | 输入要点 | 期望了解 | 实际结果 | 判读 | 原始返回 | 是否计费 |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const c of cases) {
    const o = byId.get(c.id) ?? { caseId: c.id, outcome: 'not-run' as const };
    lines.push(
      `| ${c.id} | ${c.name} | ${c.intent} | ${c.expect} | ${outcomeLabel(o)}${o.note ? `（${o.note}）` : ''} | ` +
        `${verdictOf(c, o)} | \`${compactRaw(o).replace(/\|/g, '\\|')}\` | ${billingLabel(o)} |`,
    );
  }
  lines.push('');

  /* ---- 汇总 ---- */
  const counts = { 通过: 0, 偏离: 0, 记录: 0, 未执行: 0 } as Record<Verdict, number>;
  for (const c of cases) {
    const o = byId.get(c.id) ?? { caseId: c.id, outcome: 'not-run' as const };
    counts[verdictOf(c, o)] += 1;
  }
  lines.push('## 汇总');
  lines.push('');
  lines.push(`通过 ${counts['通过']} ｜ 偏离 ${counts['偏离']} ｜ 记录 ${counts['记录']} ｜ 未执行 ${counts['未执行']}`);
  lines.push('');

  /* ---- 回填建议（§5 的「产出要求」）---- */
  lines.push('## 平台错误码回填建议');
  lines.push('');
  lines.push('依据实测的 `providerCode` 得出。**请人工复核后再改契约** ——');
  lines.push('归一是启发式的，厂商换一套错误码措辞就可能失配。');
  lines.push('');
  lines.push('| 平台错误码 | 实测到的厂商情形 | 触发用例 | 积分处理 | 频率配额 |');
  lines.push('|---|---|---|---|---|');

  const rows: Array<[PlatformErrorCode, string, number[], string, string]> = [
    ['CONTENT_BLOCKED_BY_PROVIDER', '审核拦截', [2, 3, 4, 5], '全额返还（不计费）', '计（防刷）'],
    ['INVALID_ARGUMENT', '参数非法', [6, 7], '不建 job', '计'],
    ['RATE_LIMITED', '并发超限', [9], '不建 job', '计'],
    ['PROVIDER_TIMEOUT', '超时', [10], '全额返还', '计'],
    ['PROVIDER_ERROR', '其他异常', [], '全额返还', '计'],
  ];
  for (const [code, situation, ids, credit, quota] of rows) {
    const hits = ids
      .map((id) => observations.find((o) => o.caseId === id))
      .filter((o) => o && o.platformCode === code)
      .map((o) => `${o?.caseId}（${o?.providerCode ?? '—'}）`);
    lines.push(
      `| \`${code}\` | ${situation} | ${hits.length ? hits.join('、') : '未观测到'} | ${credit} | ${quota} |`,
    );
  }
  lines.push('');

  /* ---- 契约是否要改 ---- */
  // 判据是 **stage**，不是 outcome：两种拦截的 outcome 都是 blocked，见 AuditObservation 的说明
  const blockedAtHttp = observations.filter(
    (o) => o.platformCode === 'CONTENT_BLOCKED_BY_PROVIDER' && o.stage === 'submit',
  );
  lines.push('## 一个必须确认的结论：拦截发生在同步还是异步阶段');
  lines.push('');
  lines.push('执行包里写明：**若 Provider 在同步阶段就拦截，错误码要从异步 `job.errorCode`');
  lines.push('提前到 HTTP 422，契约必须据此修正。** 实测结论：');
  lines.push('');
  if (blockedAtHttp.length === 0 && observations.some((o) => o.platformCode === 'CONTENT_BLOCKED_BY_PROVIDER')) {
    lines.push('- 拦截均表现为**任务终态 `blocked`** ⇒ 异步阶段拦截，**契约无需修正**。');
  } else if (blockedAtHttp.length > 0) {
    lines.push(
      `- 观测到 **${blockedAtHttp.length} 例在同步提交阶段就被拒绝**（用例 ${blockedAtHttp
        .map((o) => o.caseId)
        .join('、')}）⇒ **契约需修正**：为该情形补 HTTP 4xx 响应。`,
    );
  } else {
    lines.push('- **未观测到任何拦截** ⇒ 无法下结论。可能素材未触发规则，或该模型不做内容审核。');
    lines.push('  这一点本身就是重要发现：若确实不审核，则 DR-003「依赖 Provider 内置审核」不成立。');
  }
  lines.push('');

  return lines.join('\n');
}
