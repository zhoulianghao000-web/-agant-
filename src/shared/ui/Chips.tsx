import { useRef, type KeyboardEvent, type ReactNode } from 'react';

/**
 * 单选 Chips（分段控件）。
 *
 * 为什么放进 `shared/ui` 而不是写在 studio 页里：
 *   项目此前没有任何选择器类原语（只有 Card / Pill / EmptyState），
 *   而「一组互斥选项」在 M1 参数面板、M2 画布工具栏、M3 分类 Tab 里都会再用到。
 *   写在页面里等于让同一套交互与无障碍行为被复制三份 —— 复制出来的必然只改一份。
 *   补齐 `shared/ui` 本来就是 Sprint1 的既定待办（见 README「待补 Tab / IconButton / Skeleton」）。
 *
 * 无障碍：用 `radiogroup` / `radio` 语义而不是一排 button ——
 *   屏幕阅读器会正确播报「N 选 1」与当前选中项；配合 roving tabindex，
 *   整组只占一个 Tab 停留点，组内用左右方向键切换（与原生 radio 一致）。
 *   若用 `aria-pressed` 的按钮组，用户 Tab 进来要按 N 次才能穿过这一行。
 *
 * 视觉：沿用 Pill 的规则 —— 选中态只做描边 + 低透明度填充，不做大面积实色
 *   （DesignToken §4：状态色只做描边与文字）。因此它和 Pill 放在一起不会打架。
 */

export interface ChipOption {
  value: string;
  label: string;
  /** 悬停提示，用于把较长的说明藏起来、不撑破一行 */
  description?: string;
  disabled?: boolean;
}

export interface ChipsProps {
  options: readonly ChipOption[];
  value: string | null;
  onChange: (value: string) => void;
  /** 无障碍名称。必填 —— 没有它屏幕阅读器只会念「单选按钮组」 */
  ariaLabel: string;
  /** 每个 chip 的 testId 为 `${testIdPrefix}-${value}`，便于 e2e 精确点击 */
  testIdPrefix?: string;
  className?: string;
}

export function Chips({
  options,
  value,
  onChange,
  ariaLabel,
  testIdPrefix,
  className,
}: ChipsProps): ReactNode {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const enabledIndexes = options
    .map((o, i) => (o.disabled ? -1 : i))
    .filter((i) => i !== -1);

  /** 找到从 from 出发、按 step 方向的下一个可用项（循环） */
  const nextEnabled = (from: number, step: 1 | -1): number => {
    if (enabledIndexes.length === 0) return -1;
    const shape = options.length;
    let i = from;
    for (let hop = 0; hop < shape; hop += 1) {
      i = (i + step + shape) % shape;
      if (!options[i]?.disabled) return i;
    }
    return from;
  };

  const moveTo = (index: number): void => {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    refs.current[index]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>, index: number): void => {
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown': {
        event.preventDefault();
        const next = nextEnabled(index, 1);
        if (next !== -1) moveTo(next);
        break;
      }
      case 'ArrowLeft':
      case 'ArrowUp': {
        event.preventDefault();
        const prev = nextEnabled(index, -1);
        if (prev !== -1) moveTo(prev);
        break;
      }
      case 'Home': {
        event.preventDefault();
        if (enabledIndexes.length > 0) moveTo(enabledIndexes[0] as number);
        break;
      }
      case 'End': {
        event.preventDefault();
        if (enabledIndexes.length > 0) moveTo(enabledIndexes[enabledIndexes.length - 1] as number);
        break;
      }
      default:
        break;
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={`flex flex-wrap items-center gap-1.5 ${className ?? ''}`}
    >
      {options.map((option, index) => {
        const selected = option.value === value;
        // roving tabindex：选中项可 Tab 进入；没有选中项时让首个可用项承接焦点
        const focusable = selected || (value === null && enabledIndexes[0] === index);
        return (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={option.description ? `${option.label}：${option.description}` : option.label}
            title={option.description}
            tabIndex={focusable ? 0 : -1}
            disabled={option.disabled}
            data-testid={testIdPrefix ? `${testIdPrefix}-${option.value}` : undefined}
            onClick={() => {
              if (!option.disabled) onChange(option.value);
            }}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] whitespace-nowrap transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-45 ${
              selected
                ? 'border-brand/45 bg-brand-500/12 text-brand-300'
                : 'border-border text-content-secondary hover:bg-surface-hover hover:text-content-primary'
            }`}
          >
            {selected ? <span aria-hidden="true">✓</span> : null}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
