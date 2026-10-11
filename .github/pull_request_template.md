## 这个 PR 做了什么

<!-- 一句话说清。若是修复，写清故障现象与根因 -->

## 关联

- 任务 / 风险：
- 契约变更（若是）：是否需要同步 `contracts/openapi.yaml`，并已跑 `npm run contract:types`

## 自检清单

- [ ] `npm run verify` 本地全绿（lint + typecheck + test + build）
- [ ] 没有硬编码色值（颜色一律来自 `design-tokens.css` 或 Tailwind 语义类）
- [ ] 品牌底上的文字用的是 `text-content-onbrand`（近黑），不是白色
- [ ] 没有无参数调用 `invalidateQueries()`（ESLint 会拦截）
- [ ] 没有把服务端实体复制进全局 store（领域数据只能走 TanStack Query）
- [ ] 没有新增 `.env` 文件入库；`VITE_*` 里没有密钥
- [ ] 提交生成类请求时复用了同一个 `Idempotency-Key`（重试不得换键）

## 验证证据

<!-- 无证据 = 未完成。至少给一类：命令+退出码+输出 / 用例数+通过数 / 截图+步骤+环境 / Status Code+Body -->

```
```

## 已知限制 / 未验证项

<!-- 不得隐藏。写清「什么没验证、为什么、影响什么」 -->
