/**
 * 模块注册表（对应架构设计 v1.1 · B5.2 / B5.3）
 *
 * 三件事实集中在这里声明，避免散落在路由、侧栏、keep-alive 三处各写一遍：
 *   1. 一级导航的顺序与标签（恒定置顶，永远可见、永远同位）
 *   2. 路由前缀（Deep Link 协议的唯一入口）
 *   3. 切换保持策略（M1/M2 常驻、M3 卸载 —— 依据是「重建成本 ÷ 内存占用」）
 */

export type ModuleKey = 'studio' | 'assets' | 'discover';

export interface ModuleDescriptor {
  key: ModuleKey;
  /** 一级导航文案 */
  label: string;
  /** 路由前缀，同时是 Deep Link 的入口 */
  path: string;
  /** 一句话用途，用于导航 tooltip */
  purpose: string;
  /**
   * 模块切换时是否保持挂载（隐藏而非卸载）。
   * M1 是主战场，用户高频在 M1/M2 间往返，重建会丢未提交的 Prompt —— 必须常驻。
   * M3 是只读消费流，重建不丢状态但内存占用最高 —— 优先释放。
   */
  keepAlive: boolean;
  /** 功能开关（对应风险 R12：单模块故障可单独回滚） */
  flag: 'VITE_FLAG_STUDIO' | 'VITE_FLAG_ASSETS' | 'VITE_FLAG_DISCOVER';
}

export const MODULES: readonly ModuleDescriptor[] = [
  {
    key: 'studio',
    label: '创作',
    path: '/create',
    purpose: '多模态生成主入口：Prompt、技能、参数、结果',
    keepAlive: true,
    flag: 'VITE_FLAG_STUDIO',
  },
  {
    key: 'assets',
    label: '资产',
    path: '/assets',
    purpose: '项目、画布与素材的唯一沉淀地，跨模块共享数据源',
    keepAlive: true,
    flag: 'VITE_FLAG_ASSETS',
  },
  {
    key: 'discover',
    label: '发现',
    path: '/discover',
    purpose: '只读作品流与一键同款，反哺创作',
    keepAlive: false,
    flag: 'VITE_FLAG_DISCOVER',
  },
] as const;

export const DEFAULT_MODULE: ModuleKey = 'studio';

export function moduleByKey(key: ModuleKey): ModuleDescriptor | undefined {
  return MODULES.find((m) => m.key === key);
}

export function moduleByPath(pathname: string): ModuleDescriptor | undefined {
  return MODULES.find((m) => pathname.startsWith(m.path));
}

/** 模块级开关：off 的模块在侧栏置灰并在路由层拦截 */
export function isModuleEnabled(m: ModuleDescriptor): boolean {
  const value = import.meta.env[m.flag];
  return value !== 'off';
}
