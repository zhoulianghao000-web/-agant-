import type { ReactNode } from 'react';
import { Card } from '@/shared/ui/Card';
import { Pill } from '@/shared/ui/Pill';
import { EmptyState } from '@/shared/ui/EmptyState';

/**
 * M2 资产中枢 —— 阶段 0 骨架页
 *
 * 阶段 0 只声明**结构**，不实现数据：左侧树（项目 → 画布/素材/主体）+
 * 右侧网格 + 资产详情抽屉。这里把三块占位与它们承担的不变量写清楚，
 * 让 Sprint1 接手时不会把「引用式」做成「副本式」。
 */
export default function AssetsPage(): ReactNode {
  return (
    <div className="flex h-full min-h-0" data-testid="page-assets">
      {/* 左侧树：表达的是「引用关系视图」，不是物理归属 */}
      <aside className="border-border w-56 shrink-0 border-r p-3">
        <div className="flex items-center gap-2">
          <h1 className="text-content-primary text-[13px] font-semibold">M2 资产中枢</h1>
          <Pill tone="neutral">骨架</Pill>
        </div>
        <ul className="mt-3 flex flex-col gap-1 text-[12.5px]">
          {['全部资产', '未归类', '最近使用', '项目 A', '项目 B'].map((label) => (
            <li
              key={label}
              className="text-content-secondary hover:bg-surface-hover cursor-default rounded-lg px-2 py-1.5"
            >
              {label}
            </li>
          ))}
        </ul>
        <p className="text-content-disabled mt-4 text-[11px] leading-relaxed">
          「未归类」与「最近使用」是对抗「全局资产库找不到东西」的两个补丁（B3.1）
        </p>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col gap-3 p-4">
        <Card title="资产网格（Sprint1 实现）" hint="网格 / 列表双视图 + 筛选">
          <EmptyState
            testId="assets-empty"
            title="暂无资产"
            description="生成产物会自动落库并带上不可变快照。资产不会因删除项目而消失 —— 项目只持有引用。"
          />
        </Card>

        <Card title="本页承担的两条不变量" hint="Sprint1 验收锚点">
          <ul className="text-content-secondary flex flex-col gap-1.5 text-[12px]">
            <li>
              <span className="text-brand-300 font-mono">I1</span> 项目与画布只存{' '}
              <span className="font-mono">asset:&#123;id&#125;</span> 引用，同一资产可被多个项目复用而不复制实体
            </li>
            <li>
              <span className="text-brand-300 font-mono">I4</span> 被引用的资产受软删除保护：删除时返回{' '}
              <span className="font-mono">409 ASSET_REFERENCED</span>，必须先解除引用
            </li>
          </ul>
        </Card>
      </div>
    </div>
  );
}
