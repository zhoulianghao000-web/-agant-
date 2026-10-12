/**
 * 服务端配置层（BFF 骨架）
 *
 * ⚠️ 命名铁律：本文件读取的环境变量**不带 `VITE_` 前缀**。
 *    Vite 会把 `VITE_*` 变量注入前端 bundle，任何人打开 DevTools 都能看到；
 *    因此 Provider 的 API Key 只能走**无前缀**变量，且只在本进程内可见。
 *    这条规则由 `tests/secrets.test.ts` 强制（禁止在 src/ 中出现无前缀的密钥读取）。
 *
 * 为什么自己解析 .env 而不用 `node --env-file`：
 *    `--env-file` 在缺失文件时会直接报错退出，而我们要的是「没填 Key 也能启动、
 *    只是降级为 stub」。自己解析才能把这个分支控制住，也顺带保持零依赖。
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface ProviderConfig {
  /** 供应商标识，用于日志与 Model Registry */
  id: string;
  displayName: string;
  baseUrl: string;
  apiKey: string;
  submitPath: string;
  pollPath: string;
  cancelPath: string;
  /** 轮询间隔（毫秒） */
  pollIntervalMs: number;
  /** 单次任务超时（毫秒） */
  timeoutMs: number;
  /** 厂商错误码 → 平台错误码的映射（JSON 字符串） */
  errorMap: Record<string, string>;
}

/** 极简 .env 解析：KEY=VALUE，忽略注释与空行，支持两侧引号 */
function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const ENV_CACHE = new Map<string, Record<string, string>>();

function loadEnvFile(fileName: string): Record<string, string> {
  const cached = ENV_CACHE.get(fileName);
  if (cached) return cached;
  const full = resolve(process.cwd(), fileName);
  const parsed = existsSync(full) ? parseEnvFile(readFileSync(full, 'utf8')) : {};
  ENV_CACHE.set(fileName, parsed);
  return parsed;
}

/**
 * 优先级：真实环境变量 > 指定的 .env 文件 > 默认值
 *
 * `file` 参数是刻意的：生成能力（`.env.provider`）与 LLM（`.env.llm`）是**两套独立配置**。
 * 它们的 Key、配额、计费口径、限流策略、失败语义都不同 —— 混用会导致
 * 「换一个语言模型」会动到生成链路、「生成超时」污染 LLM 的错误统计。
 */
function env(key: string, fallback = '', file = '.env.provider'): string {
  const real = process.env[key];
  if (real !== undefined && real !== '') return real;
  return loadEnvFile(file)[key] || fallback;
}

export function loadProviderConfig(): ProviderConfig {
  let errorMap: Record<string, string> = {};
  const rawMap = env('PROVIDER_ERROR_MAP');
  if (rawMap) {
    try {
      errorMap = JSON.parse(rawMap) as Record<string, string>;
    } catch {
      console.warn('[config] PROVIDER_ERROR_MAP 不是合法 JSON，已忽略并使用内置默认映射');
    }
  }

  return {
    id: env('PROVIDER_ID', 'generic-http'),
    displayName: env('PROVIDER_DISPLAY_NAME', '通用 HTTP Provider'),
    baseUrl: env('PROVIDER_BASE_URL').replace(/\/+$/, ''),
    apiKey: env('PROVIDER_API_KEY'),
    submitPath: env('PROVIDER_SUBMIT_PATH', '/v1/generations'),
    pollPath: env('PROVIDER_POLL_PATH', '/v1/generations/{id}'),
    cancelPath: env('PROVIDER_CANCEL_PATH', '/v1/generations/{id}/cancel'),
    pollIntervalMs: Number(env('PROVIDER_POLL_INTERVAL_MS', '2000')) || 2000,
    timeoutMs: Number(env('PROVIDER_TIMEOUT_MS', '300000')) || 300000,
    errorMap,
  };
}

/**
 * Key 掩码：只保留长度与末 4 位。
 * 任何日志、接口响应、错误信息都必须走这里 —— 明文 Key 一旦进了日志就等同于泄漏。
 */
export function maskKey(key: string): string {
  if (!key) return '(未配置)';
  if (key.length <= 8) return `****（长度 ${key.length}）`;
  return `${'*'.repeat(Math.min(12, key.length - 4))}${key.slice(-4)}（长度 ${key.length}）`;
}

export interface ConfigReport {
  configured: boolean;
  /** 已就绪的变量 */
  present: string[];
  /** 缺失的变量（按重要性排序） */
  missing: string[];
  masked: Record<string, string>;
}

/** 供 `provider:check` 与 `/v1/provider/status` 复用的自检报告 */
export function reportProviderConfig(cfg: ProviderConfig): ConfigReport {
  const required: Array<[string, string]> = [
    ['PROVIDER_BASE_URL', cfg.baseUrl],
    ['PROVIDER_API_KEY', cfg.apiKey],
  ];
  const optional: Array<[string, string]> = [
    ['PROVIDER_ID', cfg.id],
    ['PROVIDER_SUBMIT_PATH', cfg.submitPath],
    ['PROVIDER_POLL_PATH', cfg.pollPath],
    ['PROVIDER_CANCEL_PATH', cfg.cancelPath],
  ];

  const present = [...required, ...optional].filter(([, v]) => !!v).map(([k]) => k);
  const missing = required.filter(([, v]) => !v).map(([k]) => k);

  return {
    configured: missing.length === 0,
    present,
    missing,
    masked: {
      PROVIDER_ID: cfg.id,
      PROVIDER_BASE_URL: cfg.baseUrl || '(未配置)',
      PROVIDER_API_KEY: maskKey(cfg.apiKey),
      PROVIDER_SUBMIT_PATH: cfg.submitPath,
      PROVIDER_POLL_PATH: cfg.pollPath,
      PROVIDER_CANCEL_PATH: cfg.cancelPath,
    },
  };
}

/* ============================================================================
 * LLM 配置（提示词增强 / 技能体系的后端）
 *
 * 与 Provider 配置分离的理由见上方 `env()` 的注释。
 * ==========================================================================*/

export interface LlmConfig {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 单次请求超时。提示词增强是**同步交互**（用户在前端等着），
   *  所以远小于生成任务的超时 —— 生成是异步的，等几分钟无所谓 */
  timeoutMs: number;
  /**
   * 输出上限（token）。
   *
   * ⚠️ 推理模型下这个值必须包含**思维链**消耗：实测 `deepseek-flash`
   *    回答「一只猫」时 reasoning_tokens=252、最终答案仅 61 token。
   *    若把 maxTokens 设成 300，预算会被思维链吃光，`content` 返回**空字符串**
   *    且 `finish_reason: "length"` —— 这是最容易误判成「模型没返回」的坑。
   */
  maxTokens: number;
}

export function loadLlmConfig(): LlmConfig {
  const F = '.env.llm';
  return {
    provider: env('LLM_PROVIDER', 'deepseek', F),
    baseUrl: env('LLM_BASE_URL', 'https://api.deepseek.com', F).replace(/\/+$/, ''),
    apiKey: env('LLM_API_KEY', '', F),
    model: env('LLM_MODEL', 'deepseek-flash', F),
    timeoutMs: Number(env('LLM_TIMEOUT_MS', '30000', F)) || 30000,
    maxTokens: Number(env('LLM_MAX_TOKENS', '2000', F)) || 2000,
  };
}

export function reportLlmConfig(cfg: LlmConfig): ConfigReport {
  const required: Array<[string, string]> = [
    ['LLM_BASE_URL', cfg.baseUrl],
    ['LLM_API_KEY', cfg.apiKey],
    ['LLM_MODEL', cfg.model],
  ];
  const missing = required.filter(([, v]) => !v).map(([k]) => k);

  return {
    configured: missing.length === 0,
    present: required.filter(([, v]) => !!v).map(([k]) => k),
    missing,
    masked: {
      LLM_PROVIDER: cfg.provider,
      LLM_BASE_URL: cfg.baseUrl || '(未配置)',
      LLM_MODEL: cfg.model || '(未配置)',
      LLM_API_KEY: maskKey(cfg.apiKey),
      LLM_TIMEOUT_MS: String(cfg.timeoutMs),
      LLM_MAX_TOKENS: String(cfg.maxTokens),
    },
  };
}
