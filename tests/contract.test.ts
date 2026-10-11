import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

/**
 * 接口契约完整性门禁。
 *
 * 存在的理由：OpenAPI 校验器**抓不到重复键**。
 *   YAML 规范下重复的 mapping key 由实现自行取舍（多数解析器取最后一个），
 *   所以「同一个 schema 里出现两个 coverAssetId」这种错误能顺利通过
 *   openapi-spec-validator —— 本项目评审时就真的写出来过一次。
 *   `yaml` 包默认 `uniqueKeys: true`，解析即报错，正好补上这个盲区。
 *
 * 第二职责：把 DR-006 的「无套餐」约束**延伸到契约文件**。
 *   tests/no-plan-references.test.ts 只扫 app/src，契约是另一份可能被写回
 *   `plan` / `tier` 字段的资产 —— 两侧都要有护栏。
 */

const CONTRACT_PATH = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../阶段0-接口契约-v1.yaml');

/**
 * 契约当前位于规划工作区（应用仓库之外），因此单仓克隆时找不到。
 * 这里的处理是**显式跳过并告警**，而不是静默通过 —— 静默跳过等于假绿。
 * 评审发现 F6 已记录：契约应迁入 `app/contracts/openapi.yaml`，
 * 迁移后本测试自动生效，无需修改。
 */
const hasContract = existsSync(CONTRACT_PATH);
if (!hasContract) {
  console.warn(
    '[contract.test] 未找到契约文件，已跳过契约门禁。\n' +
      '  期望路径：' +
      CONTRACT_PATH +
      '\n  修复：把契约迁入 app/contracts/openapi.yaml（评审发现 F6）',
  );
}

describe.skipIf(!hasContract)('接口契约完整性（阶段0 任务 0.5）', () => {
  const raw = hasContract ? readFileSync(CONTRACT_PATH, 'utf8') : '';

  it('无重复 mapping key（OpenAPI 校验器的盲区）', () => {
    // yaml 默认 uniqueKeys: true，重复键会抛 "Map keys must be unique"
    expect(() => parse(raw)).not.toThrow();
  });

  it('可解析为 OpenAPI 3.1 且核心结构齐备', () => {
    const doc = parse(raw) as {
      openapi?: string;
      paths?: Record<string, unknown>;
      components?: { schemas?: Record<string, unknown> };
    };
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths ?? {}).length).toBeGreaterThanOrEqual(18);
    expect(Object.keys(doc.components?.schemas ?? {}).length).toBeGreaterThanOrEqual(17);
  });

  it('P0 闭环必需的能力已冻结（评审补充 F1/F2/F5）', () => {
    const doc = parse(raw) as { paths: Record<string, Record<string, unknown>> };
    const paths = Object.keys(doc.paths);

    // F1：没有上传端点，P0「图 → 视频」第二步就断了
    expect(paths, '缺少上传端点（F1）').toContain('/v1/uploads');
    expect(paths, '缺少上传完成端点（F1）').toContain('/v1/uploads/{uploadId}/complete');
    // F2：DR-003 要求提供误拦申诉入口
    expect(paths, '缺少误拦申诉端点（F2）').toContain('/v1/assets/{assetId}/appeal');
    // F5：只有 PUT 没有 POST 属于「有写无建」的断链
    expect(paths, '缺少画布创建端点（F5）').toContain('/v1/canvases');

    expect(doc.paths['/v1/uploads'].post).toBeTruthy();
    expect(doc.paths['/v1/assets/{assetId}/appeal'].post).toBeTruthy();
    expect(doc.paths['/v1/canvases'].post).toBeTruthy();
  });

  it('不再出现套餐相关字段（DR-006 延伸至契约）', () => {
    // 只检查键名与 schema 字段名，不检查 description —— 契约需要在说明里
    // 写清「为什么不提供套餐」，连说明一起扫会误伤
    const doc = parse(raw) as { components: { schemas: Record<string, { properties?: Record<string, unknown> }> } };
    const banned = ['plan', 'planId', 'planType', 'tier', 'subscription', 'billingPlan'];
    const offenders: string[] = [];

    for (const [schemaName, schema] of Object.entries(doc.components.schemas)) {
      for (const prop of Object.keys(schema.properties ?? {})) {
        if (banned.includes(prop)) offenders.push(`${schemaName}.${prop}`);
      }
    }
    expect(offenders, `契约中出现套餐字段：${offenders.join(', ')}`).toEqual([]);
  });

  it('技能溯源在任务与资产两侧都可查（评审补充 F4）', () => {
    const doc = parse(raw) as {
      components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
    };
    expect(doc.components.schemas.Job?.properties).toHaveProperty('skill');
    expect(doc.components.schemas.Asset?.properties).toHaveProperty('skill');
    expect(doc.components.schemas.JobCreateRequest?.properties).toHaveProperty('skillKey');
  });

  it('派生字段被标注为 readOnly，避免被落库成冗余列', () => {
    const doc = parse(raw) as {
      components: { schemas: Record<string, { properties?: Record<string, { readOnly?: boolean }> }> };
    };
    expect(doc.components.schemas.Asset?.properties?.snapshotHash?.readOnly).toBe(true);
    expect(doc.components.schemas.Project?.properties?.assetCount?.readOnly).toBe(true);
  });
});
