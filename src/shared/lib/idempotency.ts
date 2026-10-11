/**
 * 幂等键生成与复用（对应接口契约 `Idempotency-Key`）
 *
 * 语义要求（这条比看起来重要）：
 *   - 同一个「用户意图」在重试时必须复用**同一个键**，否则重试会变成两次真实生成 ——
 *     这在积分模型下等于重复扣费。
 *   - 「用户意图」的边界由调用方定义：提交表单时生成一次，直到用户改动参数或提交成功才作废。
 *     因此本模块只提供生成器与持有器，不自己做生命周期管理。
 */

const PREFIX = 'idem';

export function newIdempotencyKey(): string {
  const rand = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2, 12);
  return `${PREFIX}_${rand}`;
}

/**
 * 意图级幂等键持有器。
 * 用法：
 *   const slot = createIdempotencySlot();
 *   submit({ ...payload, idempotencyKey: slot.get() });   // 重试时 get() 返回同一个键
 *   slot.reset();                                          // 用户改了参数 / 提交成功
 */
export interface IdempotencySlot {
  get(): string;
  reset(): void;
}

export function createIdempotencySlot(): IdempotencySlot {
  let key = newIdempotencyKey();
  return {
    get: () => key,
    reset: () => {
      key = newIdempotencyKey();
    },
  };
}
