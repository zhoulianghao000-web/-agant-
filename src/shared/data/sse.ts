import type { QueryClient } from '@tanstack/react-query';
import { SSE_INVALIDATION_MAP } from './queryKeys';
import type { JobEvent } from '@/shared/types/api';

/**
 * SSE 客户端（对应架构设计 v1.1 · B4.2）
 *
 * 三条硬约束：
 *   1. **全站只有一条连接**，由 AppProviders 持有。绝不在组件里 new EventSource ——
 *      5 个任务就是 5 条流，HTTP/1.1 下单域名 6 个并发连接会被瞬间耗尽，其余请求全部饿死。
 *   2. **断线续传**：带上次的最大 eventId 重连，服务端只补发其之后的事件 → 无重复、无丢失。
 *   3. **降级**：连接失败 / 被企业代理拦截 → 回退 3s 轮询；页面隐藏时主动断开省电。
 *
 * ⚠️ 契约修正项（需要同步到 openapi.yaml）：
 *    `EventSource` **无法自定义请求头**，因此重连时无法发送 `Last-Event-ID` 头。
 *    契约需同时接受 `?lastEventId=<n>` 查询参数。当前实现走查询参数。
 */

type Listener = (event: JobEvent) => void;

const EVENT_TYPES: readonly JobEvent['type'][] = [
  'queued',
  'running',
  'progress',
  'succeeded',
  'failed',
  'blocked',
];

class SseClient {
  private source: EventSource | null = null;
  private queryClient: QueryClient | null = null;
  private readonly perTask = new Map<number, Set<Listener>>();
  private readonly globalListeners = new Set<Listener>();
  private lastEventId = 0;
  private pollTimer: number | null = null;
  private closedByUser = false;

  bind(queryClient: QueryClient): void {
    this.queryClient = queryClient;
  }

  get isConnected(): boolean {
    return this.source !== null;
  }

  get cursor(): number {
    return this.lastEventId;
  }

  get isPolling(): boolean {
    return this.pollTimer !== null;
  }

  connect(): void {
    if (this.source) return;
    this.closedByUser = false;

    const base = import.meta.env.VITE_API_BASE_URL ?? '';
    if (!base) {
      // 后端未就绪：保持「未连接」而非报错，避免开发期噪音
      return;
    }

    // EventSource 不支持自定义请求头，续传游标只能走查询参数
    const url = `${base}/v1/events/stream?lastEventId=${this.lastEventId}`;
    const source = new EventSource(url, { withCredentials: true });
    this.source = source;

    for (const type of EVENT_TYPES) {
      source.addEventListener(type, (raw) => this.handle(raw as MessageEvent<string>));
    }

    // 心跳（服务端每 15s 发一条注释行）不会触发这里；这里只处理真正的连接异常
    source.addEventListener('error', () => {
      if (this.closedByUser) return;
      if (source.readyState === EventSource.CLOSED) {
        this.source?.close();
        this.source = null;
        this.startFallbackPolling();
      }
      // readyState === CONNECTING 时浏览器会自动重连，无需干预
    });
  }

  disconnect(): void {
    this.closedByUser = true;
    this.source?.close();
    this.source = null;
    this.stopFallbackPolling();
  }

  /** 订阅某个任务的事件；返回取消订阅函数 */
  subscribe(taskId: number, listener: Listener): () => void {
    const set = this.perTask.get(taskId) ?? new Set<Listener>();
    set.add(listener);
    this.perTask.set(taskId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.perTask.delete(taskId);
    };
  }

  /** 订阅全部事件（任务中心用） */
  subscribeAll(listener: Listener): () => void {
    this.globalListeners.add(listener);
    return () => this.globalListeners.delete(listener);
  }

  private handle(raw: MessageEvent<string>): void {
    let event: JobEvent;
    try {
      event = JSON.parse(raw.data) as JobEvent;
    } catch {
      // 解析失败不吞掉：静默丢弃会导致「进度条不动」且无从排查
      console.error('[sse] 事件解析失败', raw.data);
      return;
    }

    // 去重与乱序保护：补发 + 实时推送可能重叠
    if (event.eventId <= this.lastEventId) return;
    this.lastEventId = event.eventId;

    this.perTask.get(event.taskId)?.forEach((fn) => fn(event));
    this.globalListeners.forEach((fn) => fn(event));

    this.invalidateFor(event.type);
  }

  /**
   * 精确失效 —— 只失效该事件类型真正影响到的 key 前缀。
   * 这条规则由 ESLint 的 no-restricted-syntax 强制（见 .eslintrc.cjs）。
   */
  private invalidateFor(type: JobEvent['type']): void {
    const prefixes = SSE_INVALIDATION_MAP[type] ?? [];
    for (const queryKey of prefixes) {
      void this.queryClient?.invalidateQueries({ queryKey });
    }
  }

  private startFallbackPolling(): void {
    if (this.pollTimer !== null) return;
    const interval = Number(import.meta.env.VITE_FALLBACK_POLL_MS) || 3000;
    console.warn(`[sse] 连接不可用，降级为 ${interval}ms 轮询`);
    this.pollTimer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void this.queryClient?.invalidateQueries({ queryKey: ['jobs'] });
    }, interval);
  }

  private stopFallbackPolling(): void {
    if (this.pollTimer === null) return;
    window.clearInterval(this.pollTimer);
    this.pollTimer = null;
  }
}

export const sseClient = new SseClient();

/**
 * 页面可见性联动（对应阶段0-前端约定 §4）：
 * 移动端后台会耗电且系统会杀连接，隐藏时主动断开，恢复可见时重新连上。
 */
export function installVisibilityBridge(): () => void {
  const onVisibility = (): void => {
    if (document.visibilityState === 'visible') sseClient.connect();
    else sseClient.disconnect();
  };
  document.addEventListener('visibilitychange', onVisibility);
  return () => document.removeEventListener('visibilitychange', onVisibility);
}
