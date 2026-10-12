import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Card } from '@/shared/ui/Card';
import { Pill } from '@/shared/ui/Pill';
import { EmptyState } from '@/shared/ui/EmptyState';
import { Chips, type ChipOption } from '@/shared/ui/Chips';
import { apiFetch, ApiError, BASE_URL } from '@/shared/data/client';
import { qk } from '@/shared/data/queryKeys';
import { sseClient } from '@/shared/data/sse';
import { newIdempotencyKey } from '@/shared/lib/idempotency';
import { snapshotHash } from '@/shared/lib/snapshot';
import type { ItemList, JobEvent, PromptEnhanceResult, Skill } from '@/shared/types/api';
import {
  NO_SKILL,
  applyEnhance,
  buildEnhanceBody,
  canEnhance,
  emptySnapshot,
  markEdited,
  revertToRaw,
  toJobCreateRequest,
  type PendingSnapshot,
} from './skills';

/**
 * M1 创作引擎
 *
 * 阶段 0 的这一页承担两件事：
 *   1. 证明基础设施已通（Design Token / 单条 SSE / 幂等键 / 快照哈希）
 *   2. **把技能体系接到前端**（2026-10-12）—— 这是「门槛最低的创作入口」的落地：
 *      用户输入一句话 → 点技能 chip → 提示词被增强 → 提交时带上技能版本
 *
 * 关于技能数据来源：走契约端点 `GET /v1/skills`，**不是**调试用的 `/v1/llm/status`。
 * 后者是自检接口，把它当业务数据源会让「临时调试面」变成不可删的依赖。
 *
 * 关于待提交快照：`skill` 与 `prompt` 一起维护，提交时一并写入请求体（`skillKey`/`skillVersion`）。
 * 少写任何一个，历史作品的「一键同款」都会失去版本溯源 —— 详见 ./skills.ts 的说明。
 */
export default function StudioPage(): ReactNode {
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [idempotencyKey, setIdempotencyKey] = useState(() => newIdempotencyKey());
  const [snapshot, setSnapshot] = useState<PendingSnapshot>(emptySnapshot);
  const [skillValue, setSkillValue] = useState<string | null>(null);
  const [rawBeforeEnhance, setRawBeforeEnhance] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    // 只订阅，不建连接 —— 连接由 AppProviders 统一持有（全站一条）
    return sseClient.subscribeAll((event) => {
      setEvents((prev) => [event, ...prev].slice(0, 30));
    });
  }, []);

  /* ---------------------------------------------------------------- 技能清单 */
  const skillsQuery = useQuery({
    queryKey: qk.skills(),
    queryFn: () => apiFetch<ItemList<Skill>>('/v1/skills'),
    // 目录数据失败通常是「后端没起」，重试三次只是让用户多等三倍
    retry: 0,
  });

  const skills = skillsQuery.data?.items ?? [];
  const chipOptions: ChipOption[] = [
    ...skills.map((skill) => ({
      value: skill.key,
      label: skill.name,
      description: `v${skill.version}${skill.description ? ` · ${skill.description}` : ''}`,
    })),
    {
      value: NO_SKILL,
      label: '不使用技能',
      description: '直接用手写的提示词提交',
    },
  ];

  /* ---------------------------------------------------------------- 增强 */
  const enhance = useMutation({
    mutationFn: (body: ReturnType<typeof buildEnhanceBody>) =>
      apiFetch<PromptEnhanceResult>('/v1/prompt/enhance', { method: 'POST', body }),
    retry: 0,
    onSuccess: (result) => {
      setRawBeforeEnhance(result.raw);
      setSnapshot(applyEnhance(result));
      setNotice(
        `已由「${result.skillKey}@${result.skillVersion}」增强（${(result.elapsedMs / 1000).toFixed(1)}s · ${result.provider}/${result.model}）`,
      );
    },
    onError: (error) => setNotice(describeFailure(error)),
  });

  const guard = canEnhance({ prompt: snapshot.prompt, skillValue, busy: enhance.isPending });

  const runEnhance = (): void => {
    if (!guard.ok) {
      setNotice(guard.reason);
      return;
    }
    setNotice(null);
    enhance.mutate(buildEnhanceBody(snapshot.prompt, skillValue, 'txt2img'));
  };

  /* ------------------------------------------------- 待提交快照（验证面） */
  const submitBody = (() => {
    try {
      return toJobCreateRequest({ snapshot, model: 'txt2img-p0', seed: 42, aspect: '16:9' });
    } catch {
      return null;
    }
  })();

  return (
    <div className="flex flex-col gap-3 p-4" data-testid="page-studio">
      <div className="flex items-center gap-2">
        <h1 className="text-content-primary text-sm font-semibold">M1 创作引擎</h1>
        <Pill tone="brand">技能体系已接入</Pill>
        <Pill tone={sseClient.isConnected ? 'success' : 'warning'} testId="sse-state">
          SSE {sseClient.isConnected ? '已连接' : '未连接（后端未就绪时正常）'}
        </Pill>
      </div>

      <Card title="Prompt Hero" hint="技能 chips 在输入框上方 —— 先选技能，再增强">
        <div className="flex flex-col gap-3">
          {/* ---------- 技能选择：位于提示词输入框上方 ---------- */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="text-content-tertiary text-[11.5px]">技能</span>
              {skillsQuery.isLoading ? (
                <span className="text-content-tertiary text-[11.5px]">加载中…</span>
              ) : null}
              {skillsQuery.isError ? (
                <span className="text-warning text-[11.5px]">{describeQueryFailure(skillsQuery.error)}</span>
              ) : null}
            </div>

            <Chips
              ariaLabel="选择提示词增强技能"
              options={chipOptions}
              value={skillValue}
              onChange={setSkillValue}
              testIdPrefix="skill-chip"
            />

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                data-testid="enhance-prompt"
                onClick={runEnhance}
                disabled={!guard.ok}
                title={guard.ok ? '调用 LLM 把当前提示词改写得更完整' : guard.reason}
                className="bg-brand text-content-onbrand rounded-lg px-3.5 py-2 text-[13px] font-semibold transition-colors duration-150 hover:bg-brand-400 disabled:cursor-not-allowed disabled:opacity-45"
              >
                {enhance.isPending ? '增强中…' : '增强提示词'}
              </button>

              {snapshot.skill && rawBeforeEnhance !== null ? (
                <button
                  type="button"
                  data-testid="revert-prompt"
                  onClick={() => {
                    setSnapshot(revertToRaw(rawBeforeEnhance));
                    setNotice('已还原为增强前的原文（技能来源随之作废）');
                  }}
                  className="border-border text-content-secondary hover:bg-surface-hover rounded-lg border px-3 py-1.5 text-[11.5px]"
                >
                  还原原文
                </button>
              ) : null}

              {snapshot.skill ? (
                <Pill tone={snapshot.editedAfterEnhance ? 'warning' : 'success'} testId="skill-state">
                  {snapshot.editedAfterEnhance
                    ? `技能 ${snapshot.skill.key}@${snapshot.skill.version} · 已手改`
                    : `技能 ${snapshot.skill.key}@${snapshot.skill.version} · 原样`}
                </Pill>
              ) : null}
            </div>

            {notice ? (
              <p
                data-testid="studio-notice"
                className="text-content-secondary border-border bg-bg-sunken rounded-lg border px-3 py-2 text-[11.5px] whitespace-pre-wrap"
              >
                {notice}
              </p>
            ) : null}
          </div>

          {/* ---------- 提示词输入 ---------- */}
          <textarea
            data-testid="prompt-input"
            aria-label="提示词"
            rows={3}
            value={snapshot.prompt}
            onChange={(event) => setSnapshot((prev) => markEdited(prev, event.target.value))}
            placeholder="输入想法、脚本或上传参考，支持 / 使用技能，添加主体，和 Agent 一起创作"
            className="border-border bg-bg-sunken text-content-primary placeholder:text-content-disabled focus:border-border-brand resize-y rounded-2xl border p-4 text-[13px] outline-none"
          />

          <div className="flex flex-wrap items-center gap-2">
            {/* 品牌底 + 近黑字：对比度 9.51:1。若这里显示白字则说明 Token 被改坏了 */}
            <button
              type="button"
              data-testid="primary-action"
              disabled={!submitBody}
              className="bg-brand text-content-onbrand rounded-lg px-3.5 py-2 text-[13px] font-semibold transition-colors duration-150 hover:bg-brand-400 disabled:cursor-not-allowed disabled:opacity-45"
            >
              提交任务
            </button>
            <button
              type="button"
              className="border-border text-content-primary hover:bg-surface-hover rounded-lg border px-3.5 py-2 text-[13px] transition-colors duration-150"
            >
              作为参考图
            </button>
            <Pill tone="brand">txt2img-p0</Pill>
            <Pill tone="marketing" title="原小云雀紫，降级为营销场景强调色">
              营销场景
            </Pill>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card title="待提交快照" hint="技能版本必须随 prompt 一起提交，否则同款还原会静默漂移">
          {submitBody ? (
            <pre
              data-testid="submit-body"
              className="text-content-secondary bg-bg-sunken border-border overflow-x-auto rounded-lg border p-3 font-mono text-[11px]"
            >
              {JSON.stringify(submitBody, null, 2)}
            </pre>
          ) : (
            <EmptyState
              title="暂无待提交内容"
              description="在上方输入提示词；选了技能并增强后，这里会同时出现 skillKey 与 skillVersion。"
            />
          )}
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-[11.5px]">
            <dt className="text-content-tertiary">快照哈希</dt>
            <dd className="text-content-secondary break-all">
              {submitBody ? snapshotHash(submitBody.params) : '—'}
            </dd>
            <dt className="text-content-tertiary">幂等键</dt>
            <dd className="text-content-secondary break-all">{idempotencyKey}</dd>
          </dl>
          <button
            type="button"
            onClick={() => setIdempotencyKey(newIdempotencyKey())}
            className="border-border text-content-secondary hover:bg-surface-hover mt-3 rounded-lg border px-2.5 py-1.5 text-[11.5px]"
          >
            模拟「用户改了参数」→ 重置幂等键
          </button>
        </Card>

        <Card title="SSE 事件流" hint={`lastEventId=${sseClient.cursor}`}>
          {events.length === 0 ? (
            <EmptyState
              title="暂无事件"
              description="后端就绪后提交任务即可看到进度事件。事件流是全站唯一的 SSE 连接分发的，切换模块不会中断。"
            />
          ) : (
            <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto font-mono text-[11.5px]">
              {events.map((e) => (
                <li key={e.eventId} className="text-content-secondary flex gap-2">
                  <span className="text-content-tertiary">{String(e.eventId).padStart(4, '0')}</span>
                  <span className="text-brand-300">{e.type}</span>
                  <span>task={e.taskId}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ 错误文案 */

/** 把两类失败分开说清：请求根本没发出去（配置/连接），还是后端返回了错误 */
function describeQueryFailure(error: unknown): string {
  if (!BASE_URL) {
    return '未配置 VITE_API_BASE_URL —— 前端不知道后端在哪。请在 app/.env.development 指向 BFF（如 http://127.0.0.1:8787）';
  }
  if (error instanceof ApiError) return `技能清单加载失败：${error.status} ${error.code} —— ${error.message}`;
  // fetch 在网络层失败时只抛一个 TypeError，而浏览器**不会告诉脚本**究竟是
  // 「服务没起」还是「被 CORS 拦了」—— 出于安全，这两种情况在 JS 里长得一模一样。
  // 所以这里如实列出两种可能，而不是替用户猜一个：
  // 这条文案最初写的是「先运行 npm run dev:server」，而当时服务明明在跑、
  // 真实原因是 CORS —— 猜错会把排查方向带偏，比不猜更糟。
  return `无法连接 BFF（${BASE_URL}）。两种可能：① 服务未启动 → 运行 npm run dev:server；② 被 CORS 拦截 → 在 DevTools Console 里看是否有 CORS 报错`;
}

function describeFailure(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return error instanceof Error ? error.message : String(error);
  }

  // 后端在 502/503 时会带 hint（可执行的下一步）。契约里 Problem 允许扩展属性，
  // 所以这里读它而不改契约 —— hint 是「面向用户的动作」，比 code 更有用。
  const hint = error.problem['hint'];
  const lines = [`增强失败：${error.status} ${error.code} —— ${error.message}`];
  if (typeof hint === 'string' && hint) lines.push(hint);
  return lines.join('\n');
}
