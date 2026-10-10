import { useCallback, useEffect, useState } from "react";

/** Loads something async. `reload()` refetches in the background. */
export function useAsync<T>(fn: () => Promise<T>, key: string) {
  const [state, setState] = useState<{ key: string; data?: T; error?: Error }>({ key: "" });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    fn()
      .then((data) => live && setState({ key, data }))
      .catch((error: Error) => live && setState({ key, error }));
    return () => {
      live = false;
    };
    // fn is recreated each render; key says when the inputs really changed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick]);
  const current = state.key === key;
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data: current ? state.data : undefined, error: current ? state.error : undefined, loading: !current, reload };
}

/** Hash routing, so the same build works from a Go server and from GitHub Pages. */
export function useRoute(): { parts: string[]; go: (path: string) => void } {
  const read = () => window.location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const [parts, setParts] = useState<string[]>(read);
  useEffect(() => {
    const on = () => setParts(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return { parts, go: (p) => { window.location.hash = "/" + p.replace(/^\//, ""); } };
}

export function useTheme(): [string, () => void] {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? "dark");
  const toggle = useCallback(() => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("ms-theme", next);
    } catch {
      /* remembering the theme is optional */
    }
    setTheme(next);
  }, [theme]);
  return [theme, toggle];
}
