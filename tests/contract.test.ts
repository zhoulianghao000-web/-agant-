import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

/**
 * 接口契约完整性门禁（评审发现 F6 已闭环：契约迁入应用仓库）。
 *
 * 为什么必须是门禁而不是一次性评审：
 *   契约是「前端与后端共同相信的东西」。它出错的方式很安静 ——
 *   字段名对不上、能力没留通道、重复键把前一个定义吃掉，
 *   这些都不会让任何一方编译失败，只会在联调时爆发。
 *
 * 为什么需要单独的解析层：
 *   OpenAPI 校验器**抓不到重复 mapping key**。YAML 规范下重复键由实现自行取舍
 *   （多数解析器取最后一个），所以「同一个 schema 里出现两个同名属性」能顺利通过
 *   openapi-spec-validator。本项目评审时真的写出来过一次（`Project.coverAssetId`）。
 *   `yaml` 包默认 `uniqueKeys: true`，解析即报错，正好补上这个盲区。
 *
 * 第二职责：把 DR-006 的「无套餐」约束延伸到契约文件。
 *   tests/no-plan-references.test.ts 只扫 src，契约是另一份可能被写回
 *   `plan` / `tier` 字段的资产 —— 两侧都要有护栏。
 *
 * 契约位置：`app/contracts/openapi.yaml`（唯一真源，与实现同仓，
 * 这样 CI 才能校验它，`contract:types` 也才能在 CI 里跑）。
 */

const CONTRACT_PATH = fileURLToPath(new URL('../contracts/openapi.yaml', import.meta.url));

interface OpenApiDoc {
  openapi?: string;
  paths?: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, { properties?: Record<string, { readOnly?: boolean }> }> };
}

const raw = existsSync(CONTRACT_PATH) ? readFileSync(CONTRACT_PATH, 'utf8') : '';

describe('接口契约完整性（阶段0 任务 0.5）', () => {
  // 契约缺失必须**失败**而不是跳过 —— 静默跳过等于假绿（F6 的教训）
  it('契约文件存在于仓库内', () => {
    expect(existsSync(CONTRACT_PATH), `未找到契约：${CONTRACT_PATH}`).toBe(true);
    expect(raw.length).toBeGreaterThan(1000);
  });

  it('无重复 mapping key（OpenAPI 校验器的盲区）', () => {
    // yaml 默认 uniqueKeys: true，重复键抛 "Map keys must be unique"
    expect(() => parse(raw)).not.toThrow();
  });

  it('可解析为 OpenAPI 3.1 且核心结构齐备', () => {
    const doc = parse(raw) as OpenApiDoc;
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths ?? {}).length).toBeGreaterThanOrEqual(19);
    expect(Object.keys(doc.components?.schemas ?? {}).length).toBeGreaterThanOrEqual(17);
  });

  it('P0 闭环必需的能力已冻结（评审补充 F1/F2/F5）', () => {
    const doc = parse(raw) as OpenApiDoc;
    const paths = Object.keys(doc.paths ?? {});

    // F1：没有上传端点，P0「图 → 视频」第二步就断了（用户无法提供参考图）
    expect(paths, '缺少上传端点（F1）').toContain('/v1/uploads');
    expect(paths, '缺少上传完成端点（F1）').toContain('/v1/uploads/{uploadId}/complete');
    // F2：DR-003 要求提供误拦申诉入口
    expect(paths, '缺少误拦申诉端点（F2）').toContain('/v1/assets/{assetId}/appeal');
    // F5：只有 PUT 没有 POST 属于「有写无建」的断链
    expect(paths, '缺少画布创建端点（F5）').toContain('/v1/canvases');

    expect(doc.paths?.['/v1/uploads']?.post).toBeTruthy();
    expect(doc.paths?.['/v1/assets/{assetId}/appeal']?.post).toBeTruthy();
    expect(doc.paths?.['/v1/canvases']?.post).toBeTruthy();
  });

  it('不再出现套餐相关字段（DR-006 延伸至契约）', () => {
    // 只检查属性名，不检查 description —— 契约需要在说明里写清「为什么不提供套餐」，
    // 连说明一起扫会误伤
    const doc = parse(raw) as OpenApiDoc;
    const banned = ['plan', 'planId', 'planType', 'tier', 'subscription', 'billingPlan'];
    const offenders: string[] = [];

    for (const [schemaName, schema] of Object.entries(doc.components?.schemas ?? {})) {
      for (const prop of Object.keys(schema.properties ?? {})) {
        if (banned.includes(prop)) offenders.push(`${schemaName}.${prop}`);
      }
    }
    expect(offenders, `契约中出现套餐字段：${offenders.join(', ')}`).toEqual([]);
  });

  it('技能溯源在任务与资产两侧都可查（评审补充 F4）', () => {
    const doc = parse(raw) as OpenApiDoc;
    expect(doc.components?.schemas?.Job?.properties).toHaveProperty('skill');
    expect(doc.components?.schemas?.Asset?.properties).toHaveProperty('skill');
    expect(doc.components?.schemas?.JobCreateRequest?.properties).toHaveProperty('skillKey');
  });

  it('派生字段被标注为 readOnly，避免被落库成冗余列', () => {
    const doc = parse(raw) as OpenApiDoc;
    expect(doc.components?.schemas?.Asset?.properties?.snapshotHash?.readOnly).toBe(true);
    expect(doc.components?.schemas?.Project?.properties?.assetCount?.readOnly).toBe(true);
  });

  it('生成的 TS 类型与契约同步（由 contract:types 产出）', () => {
    const generatedPath = fileURLToPath(new URL('../src/shared/types/generated.ts', import.meta.url));
    expect(existsSync(generatedPath), '缺少 generated.ts，请运行 npm run contract:types').toBe(true);

    const generated = readFileSync(generatedPath, 'utf8');
    const doc = parse(raw) as OpenApiDoc;
    const missing = Object.keys(doc.components?.schemas ?? {}).filter(
      (name) => !generated.includes(`${name}:`) && !generated.includes(`"${name}":`),
    );
    expect(missing, `generated.ts 缺失这些 schema：${missing.join(', ')}`).toEqual([]);
  });
});
