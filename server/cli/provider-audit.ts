/**
 * `npm run provider:audit` —— 任务 0.3「审核口径实测」的执行器
 *
 * 把执行包 §5 的 10 条手工用例变成一条命令，并直接产出可替换文档空表的报告。
 *
 * ⚠️ **本命令会消耗真实额度**（10 次提交，其中并发用例一次提交 8 个）。
 *    因此默认是 **dry-run**：只打印将要提交什么、消耗多少、哪些会跳过。
 *    必须显式加 `--yes` 才真正提交。这条不是形式主义 ——
 *    一个「跑一下试试」的按钮配上真额度，迟早会被误触。
 *
 * 用法：
 *   npm run provider:audit                                  # dry-run，打印计划
 *   npm run provider:audit -- --yes                         # 全部执行
 *   npm run provider:audit -- --yes --only 1,2,6            # 只跑指定用例
 *   npm run provider:audit -- --yes --concurrency 12        # 改并发档位
 *
 * 退出码：0 = 全部执行完毕（含「记录」态）｜ 1 = 有执行失败 ｜ 2 = Provider 未配置
 *
 * 测试素材（违规文本 / 真人肖像 / 商标）由操作者通过 `AUDIT_*` 变量提供，
 * 可写在 `app/.env.provider` 里。**脚本刻意不预置任何违规内容** ——
 * 见 server/audit/cases.ts 顶部的说明。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile, loadProviderConfig, maskKey } from '../config';
import { resolveProvider } from '../providers/registry';
import type { PlatformFailure } from '../providers/types';
import { AUDIT_CASES, readinessOf, type AuditCase } from '../audit/cases';
import {
  observationFromFailure,
  redactValue,
  renderMarkdownReport,
  verdictOf,
  type AuditObservation,
} from '../audit/report';

/* ------------------------------------------------------------------ 参数 */

interface Args {
  yes: boolean;
  only: number[] | null;
  concurrency: number;
  timeoutMs: number;
  outDir: string;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    yes: argv.includes('--yes'),
    only: get('--only')
      ? (get('--only') as string)
          .split(',')
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isInteger(n))
      : null,
    concurrency: Number(get('--concurrency') ?? 8) || 8,
    timeoutMs: Number(get('--timeout-ms') ?? 180000) || 180000,
    outDir: get('--out') ?? 'artifacts/provider-audit',
  };
}

const args = parseArgs(process.argv.slice(2));

/** AUDIT_* 素材来源：真实环境变量优先，其次 .env.provider（顺手，不用改 shell） */
const auditEnvFile = loadEnvFile('.env.provider');
const readAuditEnv = (key: string): string | undefined => {
  const fromProcess = process.env[key];
  if (fromProcess && fromProcess.trim()) return fromProcess;
  const fromFile = auditEnvFile[key];
  return fromFile && fromFile.trim() ? fromFile : undefined;
};

const line = (s = '') => process.stdout.write(`${s}\n`);
const rule = () => line('─'.repeat(76));

/**
 * 按**显示宽度**补空格。
 *
 * `String.padEnd` 按码元数计数，而中文字符在终端里占 2 列 ——
 * 直接用 padEnd 会让含中文的列全部错位。这份输出是要给人审阅并归档的，
 * 错位会让人误读「跳过」的原因属于哪一列。
 */
const CJK = /[\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60]/;
const displayWidth = (s: string): number =>
  [...s].reduce((n, ch) => n + (CJK.test(ch) ? 2 : 1), 0);
const pad = (s: string, target: number): string => s + ' '.repeat(Math.max(0, target - displayWidth(s)));

/* ------------------------------------------------------------------ 计划 */

const cfg = loadProviderConfig();
const { adapter, usingStub, report } = resolveProvider();

const selected = AUDIT_CASES.filter((c) => (args.only ? args.only.includes(c.id) : true));

line();
line('  神笔·画 · 任务 0.3 审核口径实测');
rule();

line('\n【1】Provider');
line(`  · adapter      ${adapter.id}（${adapter.displayName}）`);
line(`  · baseUrl      ${cfg.baseUrl || '(未配置)'}`);
line(`  · apiKey       ${maskKey(cfg.apiKey)}`);

if (!report.configured) {
  line(`  · 缺失         ${report.missing.join(', ')}`);
}

if (usingStub) {
  line('  ⚠️ 当前为 stub 模式 —— 下图结果的「拦截行为」不代表任何真实厂商。');
}

/* ------------------------------------------------------------------ 计划明细 */

const plans = selected.map((c) => ({ c, ready: readinessOf(c, readAuditEnv) }));

line('\n【2】用例计划（10 条）\n');
line(`  ${pad('#', 4)}${pad('用例', 20)}${pad('期望', 32)}状态`);
for (const { c, ready } of plans) {
  const expect = c.expectation === null ? '成功' : c.expectation === 'ANY' ? '任意（摸边界）' : c.expectation;
  line(
    `  ${pad(String(c.id), 4)}${pad(c.name, 20)}${pad(expect, 32)}` +
      `${ready.ready ? '待执行' : `跳过 —— ${ready.reason}`}`,
  );
}

const runnable = plans.filter((p) => p.ready.ready);
const submissions =
  runnable.length + (runnable.some((p) => p.c.special === 'concurrency') ? args.concurrency - 1 : 0);

line('');
line(`  预计提交 ${submissions} 次（并发用例按 ${args.concurrency} 路计）｜ 每例超时 ${args.timeoutMs / 1000}s`);
line('  ⚠️ 这会消耗真实额度，并按 Model Registry 的 costProfile 预扣积分。');

if (!args.yes) {
  rule();
  line('\n  这是 dry-run，未提交任何请求。\n');

  if (report.configured) {
    line('  确认无误后执行：');
    line('    npm run provider:audit -- --yes');
  } else {
    // 刻意在打印计划**之后**才提示未配置：拿到 Key 之前也应该能先看清楚要跑什么，
    // 否则「先申请 Key 再review计划」的顺序会让人多等一轮。
    line('  ⚠️ Provider 尚未配置，因此即使加 --yes 也无法实测。接入步骤：');
    line('    1) 在 app/.env.provider 填入 PROVIDER_BASE_URL 与 PROVIDER_API_KEY');
    line('    2) npm run provider:check      ← 先确认连通性，别直接跑实测');
    line('    3) npm run provider:audit -- --yes');
    line('');
    line('  注意：本命令测的是**生成能力 Provider**（文生图 / 图生视频），');
    line('        不是已接入的 DeepSeek / Kimi —— 那两个是 LLM，用于提示词增强。');
  }

  if (plans.some((p) => !p.ready.ready)) {
    line('\n  另有用例需先提供测试素材（写入 app/.env.provider 或设为环境变量）：');
    for (const { c, ready } of plans) {
      if (!ready.ready && c.inputEnv) line(`    ${c.inputEnv}=…   （用例 ${c.id} ${c.name}）`);
    }
  }
  line();
  process.exit(0);
}

if (!report.configured) {
  rule();
  line('\n  无法实测：Provider 未配置完整。\n');
  line(`  缺失：${report.missing.join(', ')}`);
  line('  接入步骤见 app/README.md 的「Provider 接入」章节；填入后先跑 npm run provider:check。');
  line();
  process.exit(2);
}

/* ------------------------------------------------------------------ 执行 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 提交一例并轮询到终态；任何失败都归一为观测记录，不抛 */
async function runCase(auditCase: AuditCase, timeoutMs: number): Promise<AuditObservation> {
  const t0 = Date.now();
  try {
    const submitted = await adapter.submit(auditCase.build(readAuditEnv));
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const polled = await adapter.poll(submitted.providerJobId);

      if (polled.status === 'succeeded') {
        return {
          caseId: auditCase.id,
          outcome: 'succeeded',
          platformCode: null,
          elapsedMs: Date.now() - t0,
          billed: true,
          raw: redactValue({ providerJobId: submitted.providerJobId, ...polled }),
        };
      }
      if (polled.status === 'failed' || polled.status === 'blocked') {
        // 提交已成功 ⇒ 这是**异步阶段**的终态（与同步被拒的结论相反，见 report.ts 的 stage 说明）
        if (polled.failure) return observationFromFailure(auditCase.id, polled.failure, Date.now() - t0, 'poll');
        return {
          caseId: auditCase.id,
          outcome: polled.status,
          platformCode: 'PROVIDER_ERROR',
          note: '厂商返回终态但未提供失败原因',
          elapsedMs: Date.now() - t0,
          raw: redactValue(polled),
        };
      }
      await sleep(Math.max(500, cfg.pollIntervalMs));
    }

    // 本地超时：如实说明「这是本地判定的超时，不是观测到了厂商的阈值」
    const failure: PlatformFailure = {
      code: 'PROVIDER_TIMEOUT',
      providerCode: '(local-timeout)',
      message: `本地等待超过 ${timeoutMs}ms 仍未到终态`,
      billable: false,
      retryable: true,
      providerCharged: false,
    };
    const obs = observationFromFailure(auditCase.id, failure, Date.now() - t0, 'poll');
    return {
      ...obs,
      note: '本地超时 —— 未观测到厂商自身阈值，如需测出可加大 --timeout-ms',
    };
  } catch (err) {
    // 走到这里说明 `submit` 本身失败了 ⇒ **同步阶段**被拒。
    // 这正是执行包要求确认的那件事：若内容拦截发生在此处，契约必须补 HTTP 4xx。
    const failure =
      (err as { platformFailure?: PlatformFailure }).platformFailure ??
      adapter.normalize(err instanceof Error ? err.message : err);
    return observationFromFailure(auditCase.id, failure, Date.now() - t0, 'submit');
  }
}

/** 并发用例：同时提交 N 路，观察准入返回 */
async function runConcurrency(auditCase: AuditCase, n: number): Promise<AuditObservation> {
  const t0 = Date.now();
  const results = await Promise.all(
    Array.from({ length: n }, () => runCase(auditCase, 60000)),
  );
  const accepted = results.filter((r) => r.outcome === 'succeeded' || r.platformCode === null).length;
  const rateLimited = results.filter((r) => r.platformCode === 'RATE_LIMITED').length;
  const others = results.length - accepted - rateLimited;

  return {
    caseId: auditCase.id,
    // 只要有被限流就按限流记；全部被接受说明当前并发档位没触发上限（也是结论）
    outcome: rateLimited > 0 ? 'failed' : results.some((r) => r.outcome === 'succeeded') ? 'succeeded' : 'failed',
    platformCode: rateLimited > 0 ? 'RATE_LIMITED' : results[0]?.platformCode ?? null,
    providerCode: rateLimited > 0 ? '(concurrency-limit)' : results[0]?.providerCode,
    elapsedMs: Date.now() - t0,
    note: `${n} 路：接受 ${accepted}、限流 ${rateLimited}、其他 ${others}`,
    billed: false,
    raw: redactValue({
      并发档位: n,
      接受: accepted,
      限流: rateLimited,
      其他: others,
      样本: results.slice(0, 3),
    }),
  };
}

line('\n【3】执行\n');
const observations: AuditObservation[] = [];

for (const { c, ready } of plans) {
  if (!ready.ready) {
    observations.push({ caseId: c.id, outcome: 'skipped', note: ready.reason });
    line(`  － ${String(c.id).padStart(2)} ${c.name.padEnd(16)} 跳过`);
    continue;
  }

  process.stdout.write(`  … ${pad(String(c.id), 4)}${pad(c.name, 20)}`);

  let obs: AuditObservation;
  if (c.special === 'concurrency') {
    obs = await runConcurrency(c, args.concurrency);
  } else if (c.special === 'timeout') {
    obs = await runCase(c, args.timeoutMs * 2);
  } else {
    obs = await runCase(c, args.timeoutMs);
  }
  observations.push(obs);

  const verdict = verdictOf(c, obs);
  line(
    `${pad(obs.outcome, 12)}${pad(String(obs.platformCode ?? '—'), 32)}${verdict}` +
      `${obs.note ? `  （${obs.note}）` : ''}`,
  );
}

/* ------------------------------------------------------------------ 落盘 */

const outDir = resolve(process.cwd(), args.outDir);
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const meta = {
  provider: adapter.id,
  model: readAuditEnv('AUDIT_MODEL') ?? 'txt2img-p0',
  baseUrl: cfg.baseUrl,
  ranAt: new Date().toISOString(),
  concurrency: args.concurrency,
};

const mdPath = resolve(outDir, `审核口径-${stamp}.md`);
const jsonPath = resolve(outDir, `审核口径-${stamp}.json`);
writeFileSync(mdPath, renderMarkdownReport(AUDIT_CASES, observations, meta), 'utf8');
writeFileSync(jsonPath, JSON.stringify({ meta, observations }, null, 2), 'utf8');

/* ------------------------------------------------------------------ 汇总 */

rule();
const summary = { 通过: 0, 偏离: 0, 记录: 0, 未执行: 0 } as Record<string, number>;
for (const c of AUDIT_CASES) {
  const obs = observations.find((o) => o.caseId === c.id) ?? { caseId: c.id, outcome: 'not-run' as const };
  summary[verdictOf(c, obs)] += 1;
}
line(`\n  通过 ${summary['通过']} ｜ 偏离 ${summary['偏离']} ｜ 记录 ${summary['记录']} ｜ 未执行 ${summary['未执行']}`);
line(`\n  报告：${mdPath}`);
line(`  原始：${jsonPath}`);
line('\n  下一步：');
line('    · 用报告里的「平台错误码回填建议」修正 contracts/openapi.yaml 的错误码总表');
line('    · 若报告指出拦截发生在同步阶段，需为契约补 HTTP 4xx 响应（执行包 §5 的要求）');
line('    · 把报告与原始 JSON 归档到 01-阶段0-启动准备/03-验证证据/');
line();

const failed = observations.filter((o) => o.outcome === 'failed' || o.outcome === 'blocked').length;
process.exit(failed > 0 && summary['通过'] === 0 ? 1 : 0);
