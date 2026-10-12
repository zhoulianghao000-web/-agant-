/**
 * `npm run llm:check` —— LLM 接入自检
 *
 * 退出码：0 = 可用 ｜ 1 = 调用失败 ｜ 2 = 未配置（**预期中间态，不是错误**）
 *
 * 刻意包括一次**真实业务调用**（提示词增强），而不只是「能 ping 通」：
 * 鉴权通过不等于这次调用有意义 —— 推理模型下 maxTokens 设小了会返回空 content，
 * 那种情况必须在这里暴露，而不是等前端上线后才发现「增强按钮点了没反应」。
 */

import { loadLlmConfig, reportLlmConfig } from '../config';
import { resolveLlm } from '../llm/deepseek';
import { enhancePrompt, PROMPT_SKILLS } from '../llm/prompt-enhance';
import { LlmError, type LlmUsage } from '../llm/types';

const cfg = loadLlmConfig();
const report = reportLlmConfig(cfg);

const line = (s = '') => process.stdout.write(`${s}\n`);
const rule = () => line('─'.repeat(70));

line();
line('  神笔·画 · LLM 接入自检（提示词增强）');
rule();

line('\n【1】配置检查');
for (const [k, v] of Object.entries(report.masked)) {
  line(`  ${report.missing.includes(k) ? '✗' : '·'} ${k.padEnd(16)} ${v}`);
}
line('\n  Key 只显示末 4 位与长度；明文只存在于 BFF 进程内存。');

if (!report.configured) {
  rule();
  line('\n  状态：尚未配置 LLM（预期中间态，不是错误）\n');
  line('  两步接入：');
  line('    1) 复制 app/.env.llm.example 为 app/.env.llm');
  for (const k of report.missing) line(`    2) 填入 ${k}=…`);
  line('\n  该文件已被 .gitignore 忽略，不会进入版本库。');
  line();
  process.exit(2);
}

const llm = resolveLlm();

line('\n【2】鉴权与模型可用性（一次最小对话）');
try {
  const probe = await llm.chat(
    [{ role: 'user', content: '只回复两个字：可用' }],
    { maxTokens: cfg.maxTokens },
  );
  line(`  ✓ 模型 ${probe.model} 响应正常｜${probe.elapsedMs}ms`);
  line(`  ✓ 返回：${probe.content}`);
  line(`  · tokens: in=${probe.usage.promptTokens} out=${probe.usage.completionTokens}（其中思维链 ${probe.usage.reasoningTokens}）`);
} catch (err) {
  rule();
  const e = err instanceof LlmError ? err : null;
  line('\n  结果：鉴权或模型不可用\n');
  line(`  ${e ? `[${e.code}] ${e.message}` : String(err)}`);
  if (e?.hint) line(`  下一步：${e.hint}`);
  line();
  process.exit(1);
}

line('\n【3】技能清单');
for (const s of PROMPT_SKILLS) {
  line(`  · ${s.id}@${s.version}  ${s.name} —— ${s.description}`);
}
line('  版本纪律：技能只增版本、不就地修改，否则历史作品的同款还原会静默漂移。');

line('\n【4】真实业务调用：提示词增强（输入「一只猫」）');
const t0 = Date.now();
try {
  const r = await enhancePrompt({ rawPrompt: '一只猫', skillId: 'generic', capability: 'txt2img' });
  const u: LlmUsage = r.usage;
  const reasoningShare = u.completionTokens > 0 ? Math.round((u.reasoningTokens / u.completionTokens) * 100) : 0;

  line(`  ✓ skill=${r.skillId}@${r.skillVersion}｜model=${r.model}｜${r.elapsedMs}ms`);
  line(`  ✓ 原始输入：${r.raw}`);
  line(`  ✓ 增强结果：${r.enhanced}`);
  line(
    `  · tokens: in=${u.promptTokens} out=${u.completionTokens}｜思维链 ${u.reasoningTokens}（占输出 ${reasoningShare}%）`,
  );
  if (reasoningShare >= 50) {
    line(
      `\n  ⚠️ 思维链占输出 ${reasoningShare}%，这部分**同样计费**。`,
    );
    line(`     提示词增强是高频交互，若成本敏感需评估：改用非推理模型、或对本技能缓存结果。`);
  }
  line(`  · 若 content 为空会直接抛错（LLM_TRUNCATED_BY_TOKEN_LIMIT），不会静默返回空串`);

  rule();
  line(`\n  结果：可用（${((Date.now() - t0) / 1000).toFixed(1)}s）\n`);
  line('  下一步（可选）：');
  line('    · 在 M1 的参数面板上方加「技能」选择器，把结果写入 genSnapshot.prompt');
  line('    · 同步记录 skillId + skillVersion，保证一键同款可还原');
  line();
  process.exit(0);
} catch (err) {
  rule();
  const e = err instanceof LlmError ? err : null;
  line('\n  结果：调用失败\n');
  line(`  ${e ? `[${e.code}] ${e.message}` : String(err)}`);
  if (e?.hint) line(`  下一步：${e.hint}`);
  line();
  process.exit(1);
}
