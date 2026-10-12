import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 密钥泄漏护栏（对应风险 R13）
 *
 * 为什么必须是门禁：Key 泄漏的后果是**成本失控**（别人用你的额度）与数据风险，
 * 而它发生的方式极其安静 —— 一次「为了方便」把 `PROVIDER_API_KEY` 改成
 * `VITE_PROVIDER_API_KEY`，就足以让 Key 出现在公网可下载的 JS 里，且没有任何报错。
 *
 * 本仓库是 **PUBLIC**，所以这条护栏的强度要求更高：任何入库的东西都等同于已公开。
 */

const APP_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(APP_ROOT, 'src');
const SERVER = join(APP_ROOT, 'server');

function walk(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (['.ts', '.tsx', '.css'].includes(extname(full))) acc.push(full);
  }
  return acc;
}

describe('密钥不得进入前端 bundle', () => {
  const files = [...walk(SRC), ...walk(SERVER)];

  it('扫描范围有效（护栏不能被静默跳过）', () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.endsWith('client.ts'))).toBe(true);
    expect(files.some((f) => f.endsWith('config.ts'))).toBe(true);
  });

  it('src/ 中不存在任何 VITE_ 前缀的密钥类变量', () => {
    // Vite 会把 VITE_* 注入前端产物。密钥一旦带上这个前缀 = 已公开。
    const pattern = /VITE_[A-Z0-9_]*(KEY|SECRET|TOKEN|PASSWORD)/i;
    const hits: string[] = [];

    for (const file of walk(SRC)) {
      readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .forEach((lineText, i) => {
          if (pattern.test(lineText)) hits.push(`${relative(APP_ROOT, file)}:${i + 1}  ${lineText.trim()}`);
        });
    }
    expect(hits, `发现 VITE_ 前缀密钥变量：\n${hits.join('\n')}`).toEqual([]);
  });
});

describe('.gitignore 必须覆盖所有含密钥的配置文件', () => {
  const gitignore = readFileSync(join(APP_ROOT, '.gitignore'), 'utf8');
  const lines = gitignore.split(/\r?\n/).map((l) => l.trim());

  // 两份配置各含一个 Key，且互不覆盖，必须**逐个**显式声明。
  // 这条不能想当然：`.env` 与 `.env.*.local` 两条规则都匹配不到它们，
  // 不显式声明就会把 Key 文件静默提交到 PUBLIC 仓库。
  // 这里用循环而不是复制两遍，是为了让「将来再加一份配置」时漏掉一个就会红。
  for (const name of ['.env.provider', '.env.llm']) {
    it(`显式忽略 ${name}`, () => {
      expect(lines).toContain(name);
    });

    it(`保留 ${name}.example 可入库`, () => {
      expect(lines).toContain(`!${name}.example`);
    });

    it(`${name}.example 里没有任何真实密钥值`, () => {
      const example = readFileSync(join(APP_ROOT, `${name}.example`), 'utf8');
      const assignments = example
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#') && l.includes('='));

      const suspicious = assignments.filter((l) => {
        const value = l.slice(l.indexOf('=') + 1).replace(/^["']|["']$/g, '');
        if (!value) return false;
        // 占位值必须是短的或明显的示例值；长随机串说明有人把真 Key 填进了模板
        if (value.length > 40 && !value.startsWith('{')) return true;
        return /^(sk|pk|ak)-[A-Za-z0-9]{8,}/.test(value);
      });

      expect(suspicious, `模板中出现疑似真实密钥：\n${suspicious.join('\n')}`).toEqual([]);
    });
  }
});

describe('代码中不得硬编码密钥字面量', () => {
  it('src/ 与 server/ 中不存在密钥形态的字符串', () => {
    const pattern = /['"`](sk|pk|ak)-[A-Za-z0-9_-]{16,}['"`]/;
    const hits: string[] = [];

    for (const file of [...walk(SRC), ...walk(SERVER)]) {
      readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .forEach((lineText, i) => {
          if (pattern.test(lineText)) hits.push(`${relative(APP_ROOT, file)}:${i + 1}`);
        });
    }
    expect(hits, `发现硬编码密钥：${hits.join(', ')}`).toEqual([]);
  });
});
