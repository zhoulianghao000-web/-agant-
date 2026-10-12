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
| `npm run dev:server` | 启动 BFF 骨架（默认 `127.0.0.1:8787`，热重载） |
| `npm run start:server` | 同上，不热重载 |
| `npm run provider:check` | **Provider 接入自检**：配置检查 + 真实连通性测试（退出码 0/1/2/3） |
| `npm run typecheck` | 仅类型检查（`tsc --noEmit`，覆盖 `src/` 与 `server/`） |
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
│   ├─ studio/          M1 创作引擎（index.tsx 页面 + skills.ts 技能纯逻辑）
│   ├─ assets/          M2 资产中枢
│   └─ discover/        M3 灵感广场
├─ shared/              唯一允许被 features 依赖的目录
│   ├─ data/            queryKeys（唯一 key 工厂）· client · sse
│   ├─ lib/             snapshot（快照比对）· idempotency
│   ├─ types/           api（从契约生成物再导出）· generated（机器产物，勿手改）
│   └─ ui/              Card · Pill · EmptyState · **Chips**（Sprint1 补齐 Tab / IconButton / Skeleton）
├─ store/               全局 store（只放会话级小状态）
└─ styles/              design-tokens.css（Design Token 单点真源）
```

仓库根另有：

| 路径 | 说明 |
|---|---|
| `contracts/openapi.yaml` | 接口契约唯一真源。**必须在仓库内** —— 否则 CI 无法校验契约（跑在仓库里、看不到父目录），`contract:types` 也就无从执行。评审发现 F6 已据此闭环 |
| `server/` | BFF 骨架（阶段 0 只做 Provider 接入所需的最小面：health / provider/status / provider/ping，零依赖，只用 `node:http`） |
| `.env.provider.example` | Provider 配置模板；真实的 `.env.provider` 已被 `.gitignore` 显式忽略（含 API Key） |

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
2. 补齐 `shared/ui`：Tab / IconButton / Skeleton（**Chips 已于 2026-10-12 补齐**）
3. M1 最小闭环：提交任务 → 进度 → 结果
4. 把调试台的 10 条断言 + **技能链路的 16 条浏览器断言**改写为 Node 版 Playwright e2e。
   当前那 16 条断言是 Python 脚本（临时验证工具，存于阶段归档的验证证据里）——
   交叉工具链不适合长期留在仓库，Sprint1 应统一到 Node Playwright
5. ~~契约修正：SSE 需接受 `?lastEventId=`~~ → **已在契约 v1 中补上**（含原因说明）
6. 正式 Logo 图形（当前为「霓虹青方块 + 文字」占位字标）

## Provider 接入（阶段 0 · 任务 0.1 / 0.2）

Key 到手后三步接通：

```bash
cp .env.provider.example .env.provider   # 1) 复制模板（该文件已被 gitignore，不会提交）
#          2) 填入 PROVIDER_BASE_URL 与 PROVIDER_API_KEY
npm run provider:check                   # 3) 自检：真实提交一次最小任务并轮询到终态
```

退出码：`0` 连通且拿到产物 ｜ `1` 连通失败（已打印厂商返回与排查顺序）｜ `2` 尚未配置 Key（**预期中间态，不是错误**）｜ `3` 被内容审核拦截（属真实终态，需按 0.3 记录口径）

### 安全红线（风险 R13）

- Provider 变量**不带 `VITE_` 前缀**。Vite 会把 `VITE_*` 注入前端 bundle，任何人下载 JS 都能看到 Key。
- 本仓库是 **PUBLIC**，任何入库的东西等同已公开。`tests/secrets.test.ts` 在 CI 中拦截这类误用（含 `.gitignore` 是否覆盖 `.env.provider` 的断言——`.env` 与 `.env.*.local` 两条规则**都匹配不到** `.env.provider`）。
- 所有输出（CLI、`/v1/provider/status`、启动日志）只显示 Key 的**末 4 位与长度**。

### 没有 Key 也能开发

Key 未配置时 BFF **降级到 stub 适配器**并标记 `usingStub: true`，而不是启动失败。
`POST /v1/provider/ping` 会真实走完 submit → poll → 拿到产物，用于先把
「提交 → 进度 → 落库 → 一键同款」整条链路跑通。结果始终带 `mockResult: true`，
避免 stub 结果被当成真实联调结论。

### 目前是「通用形态」适配器

`server/providers/http-generic.ts` 按最通用的形态实现（提交返回 jobId + 轮询取状态），
三个路径模板与厂商错误码映射都通过环境变量配置。真实 Provider 定下来后若形态不同
（例如回调式 / WebSocket 推送），**只改这一个文件**，`providers/types.ts` 的契约与上层业务代码不受影响
—— 这正是适配层存在的意义。

---

## 技能体系（提示词增强）已接入前端

M1 的「技能 chips」是当前门槛最低的创作入口（三站逆向的结论）。已打通：

```
GET  /v1/skills           → 渲染 chips（契约端点，不是调试用的 /v1/llm/status）
POST /v1/prompt/enhance   → 把 enhanced 写回提示词输入框
                          → 同时记下 skillKey + skillVersion
提交时 → JobCreateRequest.skillKey / skillVersion（契约里已有这两个字段）
```

**为什么技能版本必须与提示词一起记**：只存增强后的提示词、不存产出它的技能版本，
技能改版后历史作品的「一键同款」会还原出与原作不同的提示词 —— 而且是静默的。
`src/features/studio/skills.ts` 里这条不变量由 11 个用例锁住。

**归因的诚实性**：`editedAfterEnhance` 区分了「增强后原样使用」与「增强后手改」。
不区分的话，「哪个技能真正带来产出」这个指标就没有意义了。

**纯逻辑与渲染分离**：项目的测试环境是 node（无 jsdom），所以交互无法用组件测试覆盖。
`skills.ts` 因此只放纯函数（该不该发请求、请求体长什么样、响应如何落快照），
交互层交给浏览器实测 —— 16 条断言（含真实 LLM 调用）见本阶段归档的验证证据。

### ⚠️ 两个只在真实浏览器里才会暴露的坑（已修）

1. **`Access-Control-Allow-Origin: *` 会让所有请求被拦。**
   前端 `apiFetch` 带 `credentials: 'include'`，而规范禁止「凭据模式 + 通配来源」，
   浏览器直接拒绝。BFF 改为**回显 Origin** + `Access-Control-Allow-Credentials: true` + `Vary: Origin`。
2. **前端无法区分「服务没起」与「被 CORS 拦」。**
   fetch 在网络层失败只抛 TypeError，浏览器出于安全不告诉脚本原因。
   所以错误文案如实列出两种可能，而不是猜一个 —— 猜错会把排查方向带偏。

---

## 环境与边界

- **目标形态**：桌面浏览器。**不考虑移动端**（2026-10-11 产品决策），不设响应式适配投入；仅保留「窗口收窄不出现横向溢出」的零成本底线。
- **品牌名**：一律引用 `shared/config/brand.ts`，禁止在组件里手写「神笔·画」字面量。

## 仓库

- 远端：`https://github.com/zhoulianghao000-web/-agant-`（**public**）
- `LICENSE` 为远端初始化时带入的 **MIT**，已原样保留未改动。
  ⚠️ MIT 允许任何人自由商用与再分发 —— 若这不是预期，需尽快替换（已记录为缺口 **G10**）。
- 远端初始的 README 仅一行标题 `# -agant-`，已被本文件取代；原内容保留在此以免信息丢失。
