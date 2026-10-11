# 三合一 AIGC 创作平台 · Web 前端

> 阶段：**0（骨架就绪）** ｜ 对应实施计划任务 **0.6**
> 上游文档：`../三合一实施计划-v1.1.md`、`../三合一AIGC平台架构设计-v1.1.md`、`../阶段0-前端约定-v1.md`

---

## 快速开始

```bash
npm install
npm run dev            # http://localhost:5173
npm run verify         # lint + typecheck + test + build（提交前必跑）
```

> 本机若没有 Node.js：CodeBuddy 运行时自带 Node 22，可用其绝对路径执行，
> 例如 `& "$env:USERPROFILE\.workbuddy\binaries\node\versions\22.22.2-6\npm.cmd" install`。

## 脚本

| 命令 | 作用 |
|---|---|
| `npm run dev` | 本地开发（读取 `.env.development`） |
| `npm run dev:staging` | 以 staging 模式本地开发 |
| `npm run build` | 生产构建（typecheck + vite build） |
| `npm run build:staging` | 预发构建 |
| `npm run typecheck` | 仅类型检查（`tsc --noEmit`） |
| `npm run lint` | ESLint，`--max-warnings 0` |
| `npm run test` | Vitest 单元测试（单次） |
| `npm run verify` | 以上四项串行执行 —— **CI 与本地用同一套口径** |

---

## 目录结构（feature 自治，见 阶段0-前端约定-v1.md §1）

```
src/
├─ app/                 与业务无关的 Shell：路由、ErrorBoundary、Providers、模块注册表
├─ features/
│   ├─ studio/          M1 创作引擎
│   ├─ assets/          M2 资产中枢
│   └─ discover/        M3 灵感广场
├─ shared/              唯一允许被 features 依赖的目录
│   ├─ data/            queryKeys（唯一 key 工厂）· client · sse
│   ├─ lib/             snapshot（快照比对）· idempotency
│   ├─ types/           api（当前手工镜像契约，Sprint1 改为生成）
│   └─ ui/              Card · Pill · EmptyState（Sprint1 补齐 Tab / IconButton / Skeleton）
├─ store/               全局 store（只放会话级小状态）
└─ styles/              design-tokens.css（Design Token 单点真源）
```

**依赖方向单向**：`app → features → shared`。features 之间不得互相 import；跨模块协作只通过路由跳转与 Query 缓存。

---

## 已落地并在 CI 中强制的架构约束

| 约束 | 落地方式 | 来源 |
|---|---|---|
| 禁止全量 `invalidateQueries()` | ESLint `no-restricted-syntax` 直接报错 | B3.3 |
| 领域数据不进全局 store | `store/appStore.ts` 仅含会话状态，注释写明禁止项 | B3.3 |
| 全站单条 SSE 连接 | 连接由 `AppProviders` 持有；`sse.ts` 提供 subscribe | B4.2 |
| SSE 精确失效 | `SSE_INVALIDATION_MAP`；`progress` 不失效任何 query | B4.2 |
| 断线续传 | `?lastEventId=` 查询参数（EventSource 不支持自定义头） | B4.2 |
| 降级轮询 | 连接 CLOSED → 3s 轮询 `['jobs']`；页面隐藏时断开 | B4.2 |
| 单模块故障隔离 | 路由级 `ErrorBoundary` + 模块级功能开关 | B5.1 / R12 |
| 幂等键复用 | `createIdempotencySlot()`，重试不得换键 | B4.3 |
| 快照键序无关哈希 | `snapshotHash()` 与本机调试台同算法 | B6.1 |
| 品牌底近黑字 | Design Token `--text-on-brand`（对比度 9.51 vs 2.07） | 阶段0-DesignToken |

## 环境策略（三套）

| 环境 | 构建命令 | 配置文件 | VITE_API_BASE_URL 来源 |
|---|---|---|---|
| dev | `npm run dev` | `.env.development`（已入库，无密钥） | 空 → 退化到 mock |
| staging | `npm run build:staging` | `.env.staging`（**不入库**） | CI Variable `VITE_API_BASE_URL_STAGING` |
| prod | `npm run build` | `.env.production`（**不入库**） | CI Variable `VITE_API_BASE_URL_PROD` |

**红线**：`VITE_*` 会被打进前端 bundle，任何人可见。**模型 Provider 的 API Key 只存在于 BFF 侧**，绝不进前端（对应风险 R13，见 `../阶段0-Provider接入执行包-v1.md` §4）。

## 分支策略

| 分支 | 用途 |
|---|---|
| `main` | 受保护，只接受 PR；CI 全绿 + 1 个 approve 才能合并 |
| `feat/<task-id>-<slug>` | 功能分支，例：`feat/s1-job-submit` |
| `fix/<issue>-<slug>` | 修复分支 |

提交信息：`<type>(<scope>): <subject>`，type ∈ feat / fix / refactor / docs / test / chore。

## 待办（Sprint1 第一批）

1. 用 `openapi-typescript` 从 `../阶段0-接口契约-v1.yaml` 生成 `shared/types/generated.ts`，替换手工镜像
2. 补齐 `shared/ui`：Tab / IconButton / Skeleton
3. M1 最小闭环：提交任务 → 进度 → 结果
4. 把调试台（`../p0-debug-console.html`）的 10 条断言改写为 Playwright e2e
5. 契约修正：SSE 端点需接受 `?lastEventId=` 查询参数（EventSource 无法自定义请求头）
