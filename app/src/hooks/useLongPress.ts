import { useCallback, useEffect, useRef } from "react";

interface LongPressHandlers {
  onTouchStart: (e: React.TouchEvent) => void;
  onTouchMove: (e: React.TouchEvent) => void;
  onTouchEnd: (e: React.TouchEvent) => void;
  onTouchCancel: () => void;
  onClick: (e: React.MouseEvent) => void;
}

// Touch long-press → fires `onLongPress` after `delay` ms with the
// last-known touch point. Cancels if the user moves further than
// `moveTolerance` px (so a vertical scroll doesn't accidentally trigger
// it) or releases before the timer fires.
//
// Trailing-click suppression: after the long-press fires, the user
// usually keeps their finger down. When they finally lift, browsers
// emit a synthetic `click` on the same element; without suppression
// that click would re-fire onClick (preview / select toggle) and the
// just-opened context menu would be immediately clobbered. We set a
// `fired` flag that:
//   1) preventDefaults the touchend to break the click chain on iOS,
//   2) installs a one-shot capture-phase document `click` blocker for
//      400ms in case the browser still emits one.
// Plus the returned `onClick` handler swallows the next click on the
// originating element specifically.
export function useLongPress(
  onLongPress: (point: { x: number; y: number }) => void,
  delay = 500,
  moveTolerance = 10,
): LongPressHandlers {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startPos = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const suppressClickUntil = useRef(0);

  const cancel = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    startPos.current = null;
  }, []);

  useEffect(() => () => cancel(), [cancel]);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length !== 1) { cancel(); return; }
    const t = e.touches[0];
    startPos.current = { x: t.clientX, y: t.clientY };
    fired.current = false;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      const p = startPos.current;
      if (!p) return;
      fired.current = true;
      // Install the trailing-click blocker BEFORE calling onLongPress so
      // it captures-fires ahead of the ContextMenu component's own
      // outside-click handler (which gets registered a few µs later when
      // React commits the mount triggered by the state setter inside
      // onLongPress). Without this ordering, the trailing click reaches
      // ContextMenu first, sees "outside the menu", and immediately
      // closes the menu we just opened.
      const blockOnce = (ev: Event) => {
        ev.stopPropagation();
        ev.preventDefault();
        document.removeEventListener('click', blockOnce, true);
      };
      document.addEventListener('click', blockOnce, true);
      window.setTimeout(() => {
        document.removeEventListener('click', blockOnce, true);
      }, 1000);
      onLongPress(p);
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

  const onTouchEnd = useCallback((e: React.TouchEvent) => {
    if (fired.current) {
      // Stop the iOS synthesised click that follows touchend; the
      // global capture-phase blocker installed when the long-press
      // fired handles the document level. Local preventDefault here is
      // belt-and-braces.
      e.preventDefault();
      suppressClickUntil.current = Date.now() + 400;
    }
    cancel();
  }, [cancel]);

  const onClickHandler = useCallback((e: React.MouseEvent) => {
    if (Date.now() < suppressClickUntil.current) {
      e.stopPropagation();
      e.preventDefault();
    }
  }, []);

  return {
    onTouchStart,
    onTouchMove,
    onTouchEnd,
    onTouchCancel: cancel,
    onClick: onClickHandler,
  };
}
