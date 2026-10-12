/**
 * `npm run provider:check` —— 「填好 Key 之后跑这个」
 *
 * 退出码是刻意设计的，便于将来接进 CI 或本地一键脚本：
 *   0 = 连通且拿到产物（Key 可用）
 *   1 = 连通失败（失败原因与厂商返回已打印）
 *   2 = 尚未配置 Key（**这不是错误**，是阶段 0 的预期中间态）
 *   3 = 请求到了但结果是内容审核拦截（属真实终态，需按 0.3 记录口径）
 *
 * ⚠️ 输出中永不出现明文 Key，只有掩码。
 */

import { loadProviderConfig, reportProviderConfig } from '../config';
import { providerPing } from '../providers/ping';
import { MODEL_REGISTRY } from '../providers/registry';
import { describeFailure } from '../providers/errors';

const cfg = loadProviderConfig();
const report = reportProviderConfig(cfg);

const line = (s = '') => process.stdout.write(`${s}\n`);
const rule = () => line('─'.repeat(66));

line();
line('  神笔·画 · Provider 接入自检');
rule();

line('\n【1】配置检查');
for (const [k, v] of Object.entries(report.masked)) {
  line(`  ${report.missing.includes(k) ? '✗' : '·'} ${k.padEnd(26)} ${v}`);
}
line(`\n  API Key 掩码仅显示末 4 位与长度；明文 Key 只存在于 BFF 进程，绝不落盘或打印。`);

if (!report.configured) {
  rule();
  line('\n  状态：尚未配置 Key（阶段 0 的预期中间态，不是错误）\n');
  line('  要接通真实 Provider，只需两步：');
  line('    1) 复制 app/.env.provider.example 为 app/.env.provider');
  line('    2) 填入这两项后重新运行本命令：');
  for (const k of report.missing) line(`         ${k}=…`);
  line('\n  该文件已被 .gitignore 忽略，不会进入版本库。');
  line('  Key 绝不能加 VITE_ 前缀 —— 那会被打进前端 bundle，任何人可见。');
  line('\n  现在也可以直接跑 `npm run dev:server`，BFF 会以 stub 模式启动，');
  line('  让前端把「提交 → 进度 → 落库 → 一键同款」整条链路先跑通。');
  line();
  process.exit(2);
}

line('\n【2】模型注册表（P0 范围）');
for (const m of MODEL_REGISTRY) {
  const cost = m.costProfile.pending ? '待实测' : `${m.costProfile.price} ${m.costProfile.currency}/${m.costProfile.unit}`;
  const lat = m.latencyProfile.pending ? '待实测' : `P50 ${m.latencyProfile.p50Ms}ms / P95 ${m.latencyProfile.p95Ms}ms`;
  line(`  · ${m.modelKey.padEnd(16)} ${m.capability.padEnd(11)} 成本 ${cost.padEnd(28)} 延迟 ${lat}`);
}
line('\n  ⚠️ 标注「待实测」的数值尚未核实，禁止在界面上当真实数据展示。');

line('\n【3】连通性自测（提交一次最小任务并轮询到终态）');
const t0 = Date.now();
const result = await providerPing(120000, 1500);
for (const s of result.steps) {
  line(`  ${s.ok ? '✓' : '✗'} [${s.step.padEnd(7)}] ${s.detail}`);
}
line(`\n  耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

rule();
if (result.ok) {
  line(`\n  结果：连通成功 —— Key 可用，且能拿到产物。\n`);
  if (result.mockResult) {
    line('  ⚠️ 本次为 stub 结果，不代表真实 Provider 行为（理论上不会走到这里）。\n');
  }
  line('  下一步（任务 0.2 / 0.3）：');
  line('    · 回填 Model Registry 的 costProfile / latencyProfile 实测值');
  line('    · 按 阶段0-Provider接入执行包-v1.md §5 跑 10 条审核口径用例');
  line();
  process.exit(0);
}

if (result.failure?.code === 'CONTENT_BLOCKED_BY_PROVIDER') {
  line(`\n  结果：连通成功，但最小任务被内容审核拦截。\n`);
  line('  这仍是有效结论：说明鉴权与链路正常，且**审核确实发生在同步/近同步阶段**。');
  line('  请把返回报文记入 §5 用例表的第 2 条，并据此修正契约里的错误码位置。\n');
  process.exit(3);
}

line('\n  结果：连通失败\n');
if (result.failure) line(`  ${describeFailure(result.failure)}`);
line('\n  排查顺序：');
line('    1) baseUrl 是否可达、路径是否正确（不要多写或少写 /v1）');
line('    2) Key 是否有效、是否已过期、是否需要额外的鉴权头');
line('    3) 账号是否已开通该模型权限 / 额度是否耗尽');
line('    4) 是否需要 IP 白名单（企业网络出口 IP 变化会导致失败）');
line();
process.exit(1);
