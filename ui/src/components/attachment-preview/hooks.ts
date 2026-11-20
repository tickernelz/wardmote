import { useCallback, useEffect, useRef, useState } from "react";

/** Becomes true once the element comes within `rootMargin` of the viewport and stays true. */
export function useNearViewport<T extends Element>(rootMargin = "200px 0px") {
  const [node, setNode] = useState<T | null>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (!node || near) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setNear(true);
      observer.disconnect();
    }, { rootMargin });
    observer.observe(node);
    return () => observer.disconnect();
  }, [node, near, rootMargin]);
  return [setNode, near] as const;
}

/** Native element fullscreen, or a fixed overlay where the Fullscreen API is missing (iPhone Safari). */
export function useFullscreen<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [native, setNative] = useState(false);
  const [overlay, setOverlay] = useState(false);
  useEffect(() => {
    const onChange = () => setNative(Boolean(ref.current) && document.fullscreenElement === ref.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  useEffect(() => {
    if (!overlay) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOverlay(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [overlay]);
  const toggle = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
      return;
    }
    if (overlay) {
      setOverlay(false);
      return;
    }
    if (document.fullscreenEnabled && typeof element.requestFullscreen === "function") {
      element.requestFullscreen().catch(() => setOverlay(true));
    } else {
      setOverlay(true);
    }
  }, [overlay]);
  return { ref, active: native || overlay, overlay, toggle };
}
