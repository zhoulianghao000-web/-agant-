/**
 * `npm run llm:check` —— LLM 接入自检
 *
 * 退出码：0 = 启用的 provider 可用 ｜ 1 = 启用的 provider 调用失败 ｜ 2 = 一个都没配置
 *
 * 刻意做三件超出「能 ping 通」的事：
 *   1. 走一次**真实业务调用**（提示词增强）—— 鉴权通过不等于这次调用有意义：
 *      推理模型下 maxTokens 设小了会返回空 content，那种情况必须在这里暴露。
 *   2. **逐个 provider 实测并对比耗时** —— 「默认用谁」应该有数据支撑，而不是拍脑袋。
 *      ⚠️ 且必须**多跑几轮**：最初用单次采样（Kimi 22.2s）得出「Kimi 慢 10 倍」，
 *      多轮实测后两个 provider 其实都在 1.5–4s 量级。单样本足以得出错误结论。
 *   3. 报告**思维链占比** —— 它直接计入费用，是定价的输入。
 */

import { listLlmProfiles, type LlmProfileSummary } from '../config';
import { resolveLlm } from '../llm/openai-compatible';
import { enhancePrompt, PROMPT_SKILLS } from '../llm/prompt-enhance';
import { LlmError, type LlmUsage } from '../llm/types';

const line = (s = '') => process.stdout.write(`${s}\n`);
const rule = () => line('─'.repeat(74));

line();
line('  神笔·画 · LLM 接入自检（提示词增强）');
rule();

const profiles = listLlmProfiles();
const configured = profiles.filter((p) => p.configured);
const active = profiles.find((p) => p.isActive);

line('\n【1】Provider 配置');
for (const p of profiles) {
  const mark = p.configured ? '·' : '✗';
  line(`  ${mark} ${p.provider.padEnd(10)} ${p.model.padEnd(18)} temp=${String(p.temperature).padEnd(5)} ${p.maskedKey}${p.isActive ? '   ← 当前启用' : ''}`);
}
line('\n  Key 只显示末 4 位与长度；明文只存在于 BFF 进程内存。');

if (configured.length === 0) {
  rule();
  line('\n  状态：一个 provider 都没配置（预期中间态，不是错误）\n');
  line('  两步接入：');
  line('    1) 复制 app/.env.llm.example 为 app/.env.llm');
  line('    2) 填入至少一个 <PROVIDER>_API_KEY，然后重新运行本命令');
  line('\n  该文件已被 .gitignore 忽略，不会进入版本库。');
  line();
  process.exit(2);
}

if (!active || !active.configured) {
  line(`\n  ⚠️ 当前启用的 provider「${active?.provider ?? '(未设置)'}」未配置完整，`);
  line('     但下面仍会测试已配置好的 provider，便于你先验证 Key 可用性。');
}

line('\n【2】技能清单');
for (const s of PROMPT_SKILLS) {
  line(`  · ${s.key}@${s.version}  ${s.name} —— ${s.description}`);
}
line('  版本纪律：技能只增版本、不就地修改，否则历史作品的一键同款会静默漂移。');

interface Probe {
  profile: LlmProfileSummary;
  ok: boolean;
  probeMs: number;
  enhanceMs: number;
  enhanced: string;
  usage: LlmUsage;
  error?: LlmError | Error;
}

line('\n【3】逐个 provider 真实调用（输入「一只猫」）');
line('  提示：Kimi K2 单次约 20s+，全部测完可能需要 1 分钟。\n');

const probes: Probe[] = [];

for (const p of configured) {
  line(`  ── ${p.provider} / ${p.model}`);
  const llm = resolveLlm(p.provider);
  const probe: Probe = { profile: p, ok: false, probeMs: 0, enhanceMs: 0, enhanced: '', usage: { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0 } };

  try {
    const t0 = Date.now();
    const ping = await llm.chat([{ role: 'user', content: '只回复两个字：可用' }], { maxTokens: 800 });
    probe.probeMs = Date.now() - t0;
    line(`     ✓ 鉴权/模型可用｜${probe.probeMs}ms｜返回「${ping.content}」`);

    const t1 = Date.now();
    const r = await enhancePrompt({ rawPrompt: '一只猫', skillKey: 'generic', capability: 'txt2img' }, {});
    probe.enhanceMs = Date.now() - t1;
    probe.enhanced = r.enhanced;
    probe.usage = r.usage;
    probe.ok = true;
    line(`     ✓ 增强成功｜${probe.enhanceMs}ms｜skill=${r.skillKey}@${r.skillVersion}`);
    line(`     · 输出：${r.enhanced}`);
  } catch (err) {
    probe.error = err instanceof LlmError ? err : (err as Error);
    line(`     ✗ ${probe.error instanceof LlmError ? `[${probe.error.code}] ${probe.error.message}` : String(err)}`);
    if (probe.error instanceof LlmError && probe.error.hint) line(`       下一步：${probe.error.hint}`);
  }
  probes.push(probe);
  line('');
}

/* ---- 对比表 ---- */
rule();
line('\n【4】对比（这是「默认用谁」的决策输入）\n');
line(`  ${'provider'.padEnd(11)} ${'增强耗时'.padEnd(10)} ${'tokens(out)'.padEnd(12)} ${'思维链占比'.padEnd(11)} 结论`);
for (const pr of probes) {
  const share = pr.usage.completionTokens > 0 ? Math.round((pr.usage.reasoningTokens / pr.usage.completionTokens) * 100) : 0;
  line(
    `  ${pr.profile.provider.padEnd(11)} ${pr.ok ? `${pr.enhanceMs}ms`.padEnd(10) : '失败'.padEnd(10)} ` +
      `${String(pr.usage.completionTokens).padEnd(12)} ${pr.ok ? `${share}%`.padEnd(11) : '—'.padEnd(11)} ${pr.ok ? '可用' : '不可用'}`,
  );
}
line('\n  · 思维链 token **计入计费**，只数最终答案会严重低估成本。');
line('    但占比**波动很大**：实测 DeepSeek 41%–88%、Kimi 72%–79%。');
line('    所以它**不能当固定系数**去估算单价 —— 定价前请用本命令连测几轮取分布。');
line('  · 提示词增强是同步交互：超过 ~5s 用户就会觉得卡住，前端必须给等待反馈。');
line('  · **单次采样不足以选默认值。** 实测两个 provider 都在 1.5–4s 量级，');
line('    且各自都出现过离群值（Kimi 有过 22s）。多跑几轮再定，别用一次数据下结论。');

const activeProbe = probes.find((p) => p.profile.provider === active?.provider);

rule();
if (!activeProbe) {
  line(`\n  结果：启用的 provider「${active?.provider ?? '(未设置)'}」未配置，未做测试。\n`);
  line('  已配置且可用的：' + probes.filter((p) => p.ok).map((p) => p.profile.provider).join(', ') || '（无）');
  line('  下一步：把 LLM_PROVIDER 改成上面可用的那个。\n');
  process.exit(1);
}

if (activeProbe.ok) {
  line(`\n  结果：可用 —— provider=${activeProbe.profile.provider}，增强耗时 ${activeProbe.enhanceMs}ms\n`);
  line('  下一步（前端接入）：');
  line('    · 前端从 GET /v1/skills 读技能清单，渲染成 chips');
  line('    · 点击 chips → POST /v1/prompt/enhance → 把 enhanced 写回提示词输入框');
  line('    · 同时把响应里的 skillKey + skillVersion 存进待提交快照，提交时写入 Job.skill');
  line();
  process.exit(0);
}

line(`\n  结果：启用的 provider「${activeProbe.profile.provider}」调用失败\n`);
if (activeProbe.error instanceof LlmError) {
  line(`  [${activeProbe.error.code}] ${activeProbe.error.message}`);
  line(`  下一步：${activeProbe.error.hint}`);
}
const fallback = probes.find((p) => p.ok);
if (fallback) {
  line(`\n  可用备选：${fallback.profile.provider}（${fallback.enhanceMs}ms）。`);
  line(`  临时切换：把 .env.llm 的 LLM_PROVIDER 改为 ${fallback.profile.provider} 并重启 BFF。`);
}
line();
process.exit(1);
