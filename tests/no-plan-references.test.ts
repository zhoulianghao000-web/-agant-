import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 护栏：套餐体系已彻底移除（DR-006），且不得回流。
 *
 * 为什么用测试而不是一次性 grep：
 *   「已删除」是一个会被后续开发悄悄推翻的状态。三个月后有人为了做「付费优先队列」
 *   顺手加回一个 plan 字段，没有任何机制会拦他。这条断言把它变成构建期红灯。
 *
 * 扫描范围刻意限定在 app/src：项目文档里**需要**保留「套餐」这个词（决策记录要写
 * 「移除了什么」），若连文档一起扫，这条护栏会被自己误伤而被迫关闭。
 */

const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url));

interface Banned {
  pattern: RegExp;
  why: string;
}

const BANNED: Banned[] = [
  { pattern: /套餐/, why: '套餐（中文）' },
  { pattern: /会员/, why: '会员体系（中文）' },
  { pattern: /续费/, why: '续费' },
  { pattern: /付费档位|付费等级/, why: '付费档位' },
  { pattern: /\bsubscription(s)?\b/i, why: 'subscription' },
  { pattern: /\btier(s)?\b/i, why: 'tier' },
  { pattern: /\bplanId\b|\bplan_id\b/i, why: 'planId / plan_id' },
  { pattern: /\bplanType\b|\bplan_type\b/i, why: 'planType / plan_type' },
  { pattern: /\bworkspacePlan\b|\bworkspace_plan\b/i, why: 'workspacePlan / workspace_plan' },
  { pattern: /\.plan\b|\.tier\b/i, why: '对象属性 .plan / .tier' },
  { pattern: /\bplan\s*[:=]/, why: 'plan 赋值 / 属性定义' },
];

/**
 * 明确**不**禁的词，避免误伤：
 *   - `订阅`：SSE 事件订阅（subscribe/unsubscribe），与付费订阅无关
 *   - `计费`：上游 Provider 的成本核算（costProfile），与用户套餐无关
 *   - `充值`：积分充值，属积分体系而非套餐
 */

const SCAN_EXT = new Set(['.ts', '.tsx', '.css']);

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (SCAN_EXT.has(extname(full))) acc.push(full);
  }
  return acc;
}

describe('套餐体系已彻底移除（DR-006）', () => {
  const files = walk(SRC_DIR);

  it('src/ 目录可被扫描（护栏本身不能被静默跳过）', () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.endsWith('brand.ts'))).toBe(true);
  });

  it('不存在任何套餐相关标识', () => {
    const hits: string[] = [];

    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, index) => {
        for (const rule of BANNED) {
          if (rule.pattern.test(line)) {
            hits.push(`${relative(SRC_DIR, file)}:${index + 1}  [${rule.why}]  ${line.trim()}`);
          }
        }
      });
    }

    // 失败时把命中清单直接打出来，省去人工再搜一遍
    expect(hits, `发现套餐残留：\n${hits.join('\n')}`).toEqual([]);
  });
});
