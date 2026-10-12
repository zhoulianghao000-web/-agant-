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

const ENV_FILE = resolve(process.cwd(), '.env.provider');

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

let fileEnv: Record<string, string> | null = null;

function fromEnvFile(key: string): string {
  if (fileEnv === null) {
    fileEnv = existsSync(ENV_FILE) ? parseEnvFile(readFileSync(ENV_FILE, 'utf8')) : {};
  }
  return fileEnv[key] ?? '';
}

/** 优先级：真实环境变量 > .env.provider > 默认值 */
function env(key: string, fallback = ''): string {
  const real = process.env[key];
  if (real !== undefined && real !== '') return real;
  return fromEnvFile(key) || fallback;
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
