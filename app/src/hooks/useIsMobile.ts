import { useEffect, useState } from "react";

const QUERY = "(max-width: 767px)";

// Reactive viewport check. Tailwind's `md:` breakpoint is 768px, so anything
// below that is "mobile" for layout purposes. Using matchMedia (not a window
// resize listener) means we re-render only when the breakpoint flips, not on
// every pixel of resize.
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia(QUERY).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(QUERY);
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}
