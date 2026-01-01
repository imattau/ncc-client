import { useEffect, useRef, useState } from "react";

export function useInView<T extends HTMLElement = HTMLElement>(options: IntersectionObserverInit = {}) {
  const elementRef = useRef<T | null>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    if (inView) return;
    const node = elementRef.current;
    if (!node) return;
    let observer: IntersectionObserver | null = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting) {
          setInView(true);
          observer?.disconnect();
          observer = null;
        }
      },
      {
        rootMargin: "200px",
        threshold: 0.1,
        ...options
      }
    );

    observer.observe(node);
    return () => {
      observer?.disconnect();
    };
  }, [inView, options]);

  return [elementRef, inView] as const;
}
