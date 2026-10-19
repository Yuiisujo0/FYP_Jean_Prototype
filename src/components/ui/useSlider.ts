import { useCallback, useEffect, useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react';

export interface SliderBox { left: number; top: number; width: number; height: number }

/**
 * A highlight that slides to the active item instead of jumping (the transitions.dev "tabs sliding" pattern). The component
 * renders one absolutely positioned element inside `container`, styled with `style`; this hook measures the active item
 * (`activeSelector`) and keeps the element on it. The first position is written without a transition (`ready` is false), so
 * nothing slides in from the corner on first paint. It follows the container's size, so collapsing a sidebar re-measures.
 * `deps` are the values that change which item is active, or where it is.
 */
export function useSlider(container: RefObject<HTMLElement | null>, activeSelector: string, deps: readonly unknown[]) {
  const [box, setBox] = useState<SliderBox | null>(null);
  const [ready, setReady] = useState(false);

  const measure = useCallback(() => {
    const el = container.current?.querySelector<HTMLElement>(activeSelector);
    const next = el ? { left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight } : null;
    setBox(prev => (prev && next && prev.left === next.left && prev.top === next.top && prev.width === next.width && prev.height === next.height ? prev : next));
  }, [container, activeSelector]);

  useLayoutEffect(() => { measure(); }, [measure, ...deps]);   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = container.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => ro.disconnect();
  }, [container, measure]);

  useEffect(() => {
    if (!box || ready) return;
    let second = 0;
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => setReady(true)); });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [box, ready]);

  const style: CSSProperties = box
    ? { transform: `translate(${box.left}px, ${box.top}px)`, width: box.width, height: box.height, opacity: 1 }
    : { opacity: 0 };
  return { box, style, ready };
}
