import { useEffect, useState, type ReactNode } from 'react';
import { Card } from '@/shared/ui/Card';
import { Pill } from '@/shared/ui/Pill';
import { EmptyState } from '@/shared/ui/EmptyState';
import { sseClient } from '@/shared/data/sse';
import { newIdempotencyKey } from '@/shared/lib/idempotency';
import { snapshotHash } from '@/shared/lib/snapshot';
import type { JobEvent } from '@/shared/types/api';

/**
 * M1 创作引擎 —— 阶段 0 骨架页
 *
 * 这一页在阶段 0 的唯一职责是**证明基础设施已通**，不是实现创作功能：
 *   1. Design Token 生效（主按钮必须是「霓虹青底 + 近黑字」，可目视校验对比度规则）
 *   2. 单条 SSE 连接与事件分发可用（事件流面板）
 *   3. 幂等键与快照哈希工具可用（右侧展示）
 *
 * Sprint1 会把它替换为真正的 Prompt Hero + 参数面板 + 结果区。
 */
export default function StudioPage(): ReactNode {
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [idempotencyKey, setIdempotencyKey] = useState(() => newIdempotencyKey());

  useEffect(() => {
    // 只订阅，不建连接 —— 连接由 AppProviders 统一持有（全站一条）
    return sseClient.subscribeAll((event) => {
      setEvents((prev) => [event, ...prev].slice(0, 30));
    });
  }, []);

  const demoSnapshot = { prompt: '海岸线日出', model: 'txt2img-A', seed: 42, aspect: '16:9' };

  return (
    <div className="flex flex-col gap-3 p-4" data-testid="page-studio">
      <div className="flex items-center gap-2">
        <h1 className="text-content-primary text-sm font-semibold">M1 创作引擎</h1>
        <Pill tone="neutral">阶段 0 · 骨架</Pill>
        <Pill tone={sseClient.isConnected ? 'success' : 'warning'} testId="sse-state">
          SSE {sseClient.isConnected ? '已连接' : '未连接（后端未就绪时正常）'}
        </Pill>
      </div>

      <Card title="Prompt Hero（Sprint1 实现）" hint="主按钮配色即 Design Token 验收点">
        <div className="flex flex-col gap-3">
          <div className="border-border bg-bg-sunken text-content-disabled rounded-2xl border p-4 text-[13px]">
            输入想法、脚本或上传参考，支持 / 使用技能，添加主体，和 Agent 一起创作
          </div>
          <div className="flex items-center gap-2">
            {/* 品牌底 + 近黑字：对比度 9.51:1。若这里显示白字则说明 Token 被改坏了 */}
            <button
              type="button"
              data-testid="primary-action"
              className="bg-brand text-content-onbrand rounded-lg px-3.5 py-2 text-[13px] font-semibold transition-colors duration-150 hover:bg-brand-400"
            >
              提交任务
            </button>
            <button
              type="button"
              className="border-border text-content-primary hover:bg-surface-hover rounded-lg border px-3.5 py-2 text-[13px] transition-colors duration-150"
            >
              作为参考图
            </button>
            <Pill tone="brand">Seedance 2.5</Pill>
            <Pill tone="marketing" title="原小云雀紫，降级为营销场景强调色">
              营销场景
            </Pill>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
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

        <Card title="工具自检" hint="契约与架构约束对应的可运行证据">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-[11.5px]">
            <dt className="text-content-tertiary">幂等键</dt>
            <dd className="text-content-secondary break-all">{idempotencyKey}</dd>
            <dt className="text-content-tertiary">快照哈希</dt>
            <dd className="text-content-secondary break-all">{snapshotHash(demoSnapshot)}</dd>
            <dt className="text-content-tertiary">哈希性质</dt>
            <dd className="text-content-secondary">
              键序无关 —— 参数顺序变化不改变结果，未改参数才能命中「复用原产物」
            </dd>
          </dl>
          <button
            type="button"
            onClick={() => setIdempotencyKey(newIdempotencyKey())}
            className="border-border text-content-secondary hover:bg-surface-hover mt-3 rounded-lg border px-2.5 py-1.5 text-[11.5px]"
          >
            模拟「用户改了参数」→ 重置幂等键
          </button>
        </Card>
      </div>
    </div>
  );
}
