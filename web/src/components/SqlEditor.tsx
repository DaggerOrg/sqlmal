import { useRef } from "react";
import { highlight } from "../lib/highlight";

/** A textarea laid over a highlighted copy of its own text, so typing stays native. */
export default function SqlEditor({ value, onChange, label, rows = 12 }: { value: string; onChange: (v: string) => void; label: string; rows?: number }) {
  const pre = useRef<HTMLPreElement>(null);
  return (
    <div className="editor" style={{ ["--rows" as string]: rows }}>
      <pre ref={pre} aria-hidden>
        <code>
          {highlight(value + "\n").map((t, i) => (t.kind === "text" ? t.text : <span key={i} className={t.kind}>{t.text}</span>))}
        </code>
      </pre>
      <textarea
        aria-label={label}
        value={value}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(e) => onChange(e.target.value)}
        onScroll={(e) => { if (pre.current) { pre.current.scrollTop = e.currentTarget.scrollTop; pre.current.scrollLeft = e.currentTarget.scrollLeft; } }}
        onKeyDown={(e) => {
          // Tab inserts two spaces. Escape lets keyboard users leave the field.
          if (e.key !== "Tab" || e.shiftKey) return;
          e.preventDefault();
          const el = e.currentTarget;
          const { selectionStart: a, selectionEnd: b } = el;
          onChange(value.slice(0, a) + "  " + value.slice(b));
          requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2));
        }}
      />
    </div>
  );
}
