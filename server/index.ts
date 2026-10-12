/**
 * BFF 骨架（阶段 0 · 本地优先）
 *
 * 现状说明（重要，别把它当完整后端）：这**不是** P0 的完整 BFF，
 * 只实现了「验证 Provider 接入」所需的最小面：
 *   GET  /v1/health             健康检查
 *   GET  /v1/provider/status    配置自检（返回掩码后的 Key，绝不含明文）
 *   POST /v1/provider/ping      连通性自测：真实提交一次最小任务并轮询到终态
 *
 * 为什么先只做这三条：0.1 的出口标准是「Key 到位 + 额度限流确认 + 审核口径摸清」，
 * 而这三条恰好是它的可执行验证方式。完整 BFF（任务总线、SSE、账本、资产）在 Sprint1 展开。
 *
 * 零依赖（只用 node:http），因为这一层的目的就是「能本地跑起来自测」，
 * 引入框架只会增加与 Provider 无关的排查面。
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolveProvider, MODEL_REGISTRY } from './providers/registry';
import { providerPing } from './providers/ping';
import { listLlmProfiles, loadLlmConfig, reportLlmConfig } from './config';
import { resolveLlm } from './llm/openai-compatible';
import { enhancePrompt, listSkills } from './llm/prompt-enhance';
import { LlmError } from './llm/types';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';
const STARTED_AT = Date.now();

/**
 * CORS：本地开发期**回显请求来源**（而不是 `*`）。
 *
 * ⚠️ 这里踩过一次坑，值得写下来：最初写的是 `Access-Control-Allow-Origin: *`，
 *    结果浏览器把**所有**请求都拦了：
 *      "The value of the 'Access-Control-Allow-Origin' header in the response must not
 *       be the wildcard '*' when the request's credentials mode is 'include'."
 *    原因是前端的 `apiFetch` 带 `credentials: 'include'`（要带登录态 Cookie），
 *    而规范禁止「凭据模式 + 通配来源」的组合 —— 因为那等于允许任何站点带着用户
 *    Cookie 调我们的接口。所以必须回显具体 Origin，并显式声明允许凭据。
 *
 * ⚠️ 回显 Origin 等于**当前允许任何来源**，只适用于本地开发（调试台 :8899、
 *    Vite dev :5173、BFF :8787 属不同 origin 才需要它）。
 *    上线前必须改为白名单，已记入缺口清单 G11。
 */
function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', origin ?? '*');
  // 回显 Origin 时必须声明 Vary，否则中间缓存会把 A 站的响应喂给 B 站
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,Idempotency-Key');
  res.setHeader('Access-Control-Max-Age', '600');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const server = createServer((req, res) => {
  void (async () => {
    applyCors(req, res);
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;
    const method = (req.method ?? 'GET').toUpperCase();
    const requestId = randomUUID().slice(0, 8);

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // 请求日志：**只记方法与路径**，不记 body（body 可能含 prompt 等用户内容）与 headers（含 Authorization）
    console.log(`[${requestId}] ${method} ${path}`);

    try {
      if (method === 'GET' && path === '/v1/health') {
        sendJson(res, 200, {
          ok: true,
          service: 'shenbi-hua-bff',
          uptimeMs: Date.now() - STARTED_AT,
          node: process.version,
          env: process.env.NODE_ENV ?? 'development',
        });
        return;
      }

      if (method === 'GET' && path === '/v1/provider/status') {
        const { adapter, usingStub, report } = resolveProvider();
        sendJson(res, 200, {
          usingStub,
          configured: report.configured,
          missing: report.missing,
          masked: report.masked,
          adapter: { id: adapter.id, displayName: adapter.displayName, requiresKey: adapter.requiresKey },
          capabilities: adapter.capabilities(),
          models: MODEL_REGISTRY,
          hint: report.configured
            ? '配置完整，可运行 POST /v1/provider/ping 做真实连通性自测。'
            : '尚未配置 Key，当前为 stub。请在 app/.env.provider 填入 PROVIDER_BASE_URL 与 PROVIDER_API_KEY。',
        });
        return;
      }

      if (method === 'POST' && path === '/v1/provider/ping') {
        const body = (await readBody(req)) as { timeoutMs?: number } | null;
        const timeoutMs = Math.min(120000, Math.max(5000, Number(body?.timeoutMs) || 60000));
        const result = await providerPing(timeoutMs);
        sendJson(res, result.ok ? 200 : 502, result);
        return;
      }

      if (method === 'GET' && path === '/v1/skills') {
        // 契约端点。前端技能 chips 的数据源 —— 不是调试用的 /v1/llm/status
        sendJson(res, 200, listSkills());
        return;
      }

      if (method === 'GET' && path === '/v1/llm/status') {
        const cfg = loadLlmConfig();
        const report = reportLlmConfig(cfg);
        sendJson(res, 200, {
          configured: report.configured,
          missing: report.missing,
          masked: report.masked,
          adapter: resolveLlm().describe(),
          providers: listLlmProfiles(),
          skills: listSkills().items,
          hint: report.configured
            ? '可调用 POST /v1/prompt/enhance 做提示词增强。'
            : `尚未配置 LLM provider「${cfg.provider}」。请在 app/.env.llm 填入 ${cfg.provider.toUpperCase()}_API_KEY，模板见 .env.llm.example。`,
        });
        return;
      }

      if (method === 'POST' && path === '/v1/prompt/enhance') {
        const body = (await readBody(req)) as {
          rawPrompt?: string;
          skillKey?: string;
          capability?: 'txt2img' | 'img2video';
          includeReasoning?: boolean;
        } | null;

        const rawPrompt = (body?.rawPrompt ?? '').trim();
        if (!rawPrompt) {
          sendJson(res, 400, { code: 'INVALID_ARGUMENT', message: 'rawPrompt 不能为空' });
          return;
        }

        try {
          const result = await enhancePrompt(
            { rawPrompt, skillKey: body?.skillKey, capability: body?.capability },
            { includeReasoning: body?.includeReasoning === true },
          );
          sendJson(res, 200, result);
        } catch (err) {
          const e = err instanceof LlmError ? err : null;
          // 未配置 → 503（服务不可用，且是运营态问题）；其余 → 502（上游调用失败）
          const status = e?.code === 'LLM_NOT_CONFIGURED' ? 503 : 502;
          console.warn(`[${requestId}] 提示词增强失败：${e ? `[${e.code}] ${e.message}` : String(err)}`);
          sendJson(res, status, {
            code: e?.code ?? 'LLM_UNAVAILABLE',
            message: err instanceof Error ? err.message : String(err),
            hint: e?.hint,
          });
        }
        return;
      }

      sendJson(res, 404, {
        code: 'NOT_FOUND',
        message: `未知路由 ${method} ${path}`,
        available: [
          'GET /v1/health',
          'GET /v1/provider/status',
          'POST /v1/provider/ping',
          'GET /v1/skills',
          'GET /v1/llm/status',
          'POST /v1/prompt/enhance',
        ],
      });
    } catch (err) {
      console.error(`[${requestId}] 未捕获异常`, err instanceof Error ? err.message : err);
      sendJson(res, 500, { code: 'INTERNAL', message: err instanceof Error ? err.message : String(err) });
    }
  })();
});

server.listen(PORT, HOST, () => {
  const { usingStub, report } = resolveProvider();
  console.log(`\n神笔·画 BFF 骨架已启动  http://${HOST}:${PORT}`);
  console.log(`  Provider: ${usingStub ? 'stub（未配置 Key）' : report.masked.PROVIDER_ID}`);
  console.log(`  API Key : ${report.masked.PROVIDER_API_KEY}`);
  if (report.missing.length) {
    console.log(`  缺失变量: ${report.missing.join(', ')}  ← 填入 app/.env.provider 后重启`);
  }
  console.log('  自检: GET /v1/provider/status   POST /v1/provider/ping\n');
});
