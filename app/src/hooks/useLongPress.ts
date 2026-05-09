import { useCallback, useRef } from "react";

interface LongPressHandlers {
  onTouchStart: (e: React.TouchEvent) => void;
  onTouchMove: (e: React.TouchEvent) => void;
  onTouchEnd: () => void;
  onTouchCancel: () => void;
}

// Touch long-press → fires `onLongPress` after `delay` ms with the
// last-known touch point. Cancels if the user moves further than
// `moveTolerance` px (so a vertical scroll doesn't accidentally trigger it)
// or releases before the timer fires.
//
// We don't preventDefault on touchstart — that would block the browser's
// own scroll. Callers that want to inhibit the trailing synthetic click
// should track `firedRef` themselves; for our use (opening a context
// menu), the menu's own click-outside handler will dismiss it on the
// stray click that follows.
export function useLongPress(
  onLongPress: (point: { x: number; y: number }) => void,
  delay = 500,
  moveTolerance = 10,
): LongPressHandlers {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startPos = useRef<{ x: number; y: number } | null>(null);

  const cancel = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    startPos.current = null;
  }, []);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length !== 1) { cancel(); return; }
    const t = e.touches[0];
    startPos.current = { x: t.clientX, y: t.clientY };
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      const p = startPos.current;
      if (p) onLongPress(p);
    }, delay);
  }, [cancel, delay, onLongPress]);

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    const start = startPos.current;
    if (!start) return;
    const t = e.touches[0];
    if (Math.abs(t.clientX - start.x) > moveTolerance ||
        Math.abs(t.clientY - start.y) > moveTolerance) {
      cancel();
    }
  }, [cancel, moveTolerance]);

  return {
    onTouchStart,
    onTouchMove,
    onTouchEnd: cancel,
    onTouchCancel: cancel,
  };
}
