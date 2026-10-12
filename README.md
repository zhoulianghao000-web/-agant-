# 神笔·画 · Web 前端

> 品牌：**神笔·画**（书写规范见 `../阶段0-DesignToken-v1.md` §1.4）
> 阶段：**0（骨架就绪）** ｜ 对应实施计划任务 **0.6** ｜ 目标形态：**桌面浏览器**（不考虑移动端）
> 上游文档：`../三合一实施计划-v1.2.md`、`../三合一AIGC平台架构设计-v1.2.md`、`../阶段0-前端约定-v1.md`

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
| `npm run test` | Vitest 单元测试（单次，含契约完整性门禁） |
| `npm run contract:types` | 从 `contracts/openapi.yaml` 重新生成 `src/shared/types/generated.ts` |
| `npm run contract:check` | 重新生成类型并校验与仓库内文件一致（契约改了却忘了生成 → 失败） |
| `npm run verify` | lint → typecheck → test → contract:check → build —— **CI 与本地用同一套口径** |

> 改契约的流程：编辑 `contracts/openapi.yaml` → `npm run contract:types` → 提交两者。
> 只改契约不重新生成，CI 会拦截；直接改 `generated.ts` 会在下次生成时被覆盖。

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
│   ├─ types/           api（从契约生成物再导出）· generated（机器产物，勿手改）
│   └─ ui/              Card · Pill · EmptyState（Sprint1 补齐 Tab / IconButton / Skeleton）
├─ store/               全局 store（只放会话级小状态）
└─ styles/              design-tokens.css（Design Token 单点真源）
```

仓库根另有 **`contracts/openapi.yaml`** —— 接口契约的唯一真源。它必须在仓库内：
否则 CI 无法校验契约（跑在仓库里，看不到父目录），`contract:types` 也就无从执行。
评审发现 F6 已据此闭环。

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
| 品牌名单点真源 | `shared/config/brand.ts`；书写规范由 `tests/brand.test.ts` 断言钉死 | 阶段0-DesignToken §1.4 |

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

1. ~~用 `openapi-typescript` 从契约生成类型，替换手工镜像~~ → **已完成（2026-10-12）**：契约迁入 `contracts/openapi.yaml`，`npm run contract:types` 生成 `shared/types/generated.ts`，`api.ts` 改为从生成物再导出；CI 增加 `contract:check` 防止契约与类型不同步
2. 补齐 `shared/ui`：Tab / IconButton / Skeleton
3. M1 最小闭环：提交任务 → 进度 → 结果
4. 把调试台（`../p0-debug-console.html`）的 10 条断言改写为 Playwright e2e
5. ~~契约修正：SSE 需接受 `?lastEventId=`~~ → **已在契约 v1 中补上**（含原因说明）
6. 正式 Logo 图形（当前为「霓虹青方块 + 文字」占位字标）

## 环境与边界

- **目标形态**：桌面浏览器。**不考虑移动端**（2026-10-11 产品决策），不设响应式适配投入；仅保留「窗口收窄不出现横向溢出」的零成本底线。
- **品牌名**：一律引用 `shared/config/brand.ts`，禁止在组件里手写「神笔·画」字面量。

## 仓库

- 远端：`https://github.com/zhoulianghao000-web/-agant-`（**public**）
- `LICENSE` 为远端初始化时带入的 **MIT**，已原样保留未改动。
  ⚠️ MIT 允许任何人自由商用与再分发 —— 若这不是预期，需尽快替换（已记录为缺口 **G10**）。
- 远端初始的 README 仅一行标题 `# -agant-`，已被本文件取代；原内容保留在此以免信息丢失。
