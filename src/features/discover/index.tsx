import type { ReactNode } from 'react';
import { Card } from '@/shared/ui/Card';
import { Pill } from '@/shared/ui/Pill';
import { EmptyState } from '@/shared/ui/EmptyState';

const TABS = ['全部', '营销物料', '短剧漫剧', '电商', '动漫游戏', '教育生活'] as const;

/**
 * M3 灵感广场 —— 阶段 0 只读消费版骨架
 *
 * P0 的边界（对应架构设计 v1.1 · B2.2 / DR-002）：
 *   含：分类 Tab、网格流、hover「查看创作过程」、「一键同款」
 *   不含：点赞、评论、关注、创作者主页、推荐排序、全局搜索（均属 P2）
 *
 * 内容来源：**100% 用户自主公开**，无人工选品、无平台种子内容。
 * 因此「广场为空」是上线初期的预期状态，而不是故障。
 */
export default function DiscoverPage(): ReactNode {
  return (
    <div className="flex flex-col gap-3 p-4" data-testid="page-discover">
      <div className="flex items-center gap-2">
        <h1 className="text-content-primary text-sm font-semibold">M3 灵感广场</h1>
        <Pill tone="neutral">P0 只读消费版</Pill>
        <Pill tone="warning" title="取消人工选品后的必然状态">
          内容全部来自用户自主公开
        </Pill>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {TABS.map((tab, index) => (
          <button
            key={tab}
            type="button"
            aria-pressed={index === 0}
            className={
              index === 0
                ? 'border-brand/45 bg-brand-500/12 text-brand-300 rounded-full border px-3 py-1 text-[12px]'
                : 'border-border text-content-secondary hover:bg-surface-hover rounded-full border px-3 py-1 text-[12px]'
            }
          >
            {tab}
          </button>
        ))}
      </div>

      <Card title="作品流（Sprint1 实现）" hint="卡片：封面 + 标题 + 作者 + 一键同款">
        <EmptyState
          testId="discover-empty"
          title="广场还是空的"
          description="这是取消人工选品后的预期冷启动状态。先去创作并公开一件作品，它就会出现在这里。"
          action={
            <button
              type="button"
              className="bg-brand text-content-onbrand mt-2 rounded-lg px-3 py-1.5 text-[12px] font-semibold"
            >
              去创作并公开
            </button>
          }
        />
      </Card>

      <Card title="一键同款的产品承诺" hint="B6.1">
        <ul className="text-content-secondary flex flex-col gap-1.5 text-[12px]">
          <li>继承完整快照：Prompt、模型与版本、全部参数、随机种子、参考资产</li>
          <li>
            <span className="text-success">未改动任何参数</span> → 直接复用原产物（零等待、零积分）
          </li>
          <li>
            <span className="text-warning">改动任意参数</span> → 重新生成，并在提交前提示「结果将与原作品存在差异」
          </li>
          <li>始终提供「换一个种子」入口 —— 把「同款但不同」变成可探索的能力，而不是缺陷</li>
        </ul>
      </Card>
    </div>
  );
}
