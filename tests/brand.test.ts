import { describe, expect, it } from 'vitest';
import { BRAND } from '@/shared/config/brand';

/**
 * 品牌书写规范测试。
 *
 * 为什么值得写测试：品牌名一旦出现「神笔画 / 神笔-画 / 神笔 画」这类变体，
 * 在 UI 上是随机散布、在代码里搜不到、在 Code Review 里也容易漏 ——
 * 只能靠一条断言把它钉死。
 */
describe('BRAND', () => {
  it('中间必须是中文间隔号 U+00B7，且前后不加空格', () => {
    expect(BRAND.name).toBe('神笔\u00B7画');
    expect(BRAND.name).not.toContain(' ');
  });

  it('不得使用会被误认作分隔符的其他字符', () => {
    // 常见误写：半角点、连字符、顿号、全角间隔号 U+30FB
    for (const wrong of ['神笔.画', '神笔-画', '神笔、画', '神笔・画', '神笔画']) {
      expect(BRAND.name).not.toBe(wrong);
    }
  });

  it('全称以品牌名开头，使用同一间隔号', () => {
    expect(BRAND.fullName.startsWith(BRAND.name)).toBe(true);
    expect(BRAND.fullName).toContain('\u00B7');
  });

  it('ASCII 标识可用于仓库名 / 包名（仅小写字母、数字与连字符）', () => {
    expect(BRAND.ascii).toMatch(/^[a-z0-9-]+$/);
  });

  it('简称不包含间隔号，用于空间不足的场景', () => {
    expect(BRAND.short).toBe('神笔');
    expect(BRAND.short).not.toContain('\u00B7');
  });
});
