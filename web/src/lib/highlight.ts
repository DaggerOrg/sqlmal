// A small SQL tokenizer for display. It highlights, it does not parse.

export type TokenKind = "kw" | "str" | "com" | "num" | "ident" | "text";
export interface Token { kind: TokenKind; text: string }

const KEYWORDS = new Set(
  `ADD ALTER AND AS ASC BEGIN BETWEEN BIGINT BIGSERIAL BOOLEAN BY CASCADE CASE CHAR CHECK COLUMN COMMIT CONCURRENTLY CONSTRAINT CREATE CURRENT_TIMESTAMP DATA DEFAULT DELETE DESC DISTINCT DROP ELSE END ENUM EXISTS FALSE FOREIGN FROM GENERATED IF IN INDEX INSERT INT INTEGER INTO IS JOIN KEY LIMIT NOT NOW NULL NULLIF ON ONLY OR ORDER PRIMARY REFERENCES RENAME RESTRICT SELECT SERIAL SET SMALLINT SMALLSERIAL TABLE TEXT THEN TIMESTAMPTZ TO TRUE TRUNCATE TYPE UNIQUE UPDATE USING VALUE VALUES VARCHAR VIEW WHEN WHERE WITH`.split(/\s+/),
);

export function highlight(sql: string): Token[] {
  const out: Token[] = [];
  const push = (kind: TokenKind, text: string) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.kind === kind && (kind === "text" || kind === "com")) last.text += text;
    else out.push({ kind, text });
  };
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === "-" && sql[i + 1] === "-") {
      let j = i;
      while (j < n && sql[j] !== "\n") j++;
      push("com", sql.slice(i, j));
      i = j;
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      const j = end < 0 ? n : end + 2;
      push("com", sql.slice(i, j));
      i = j;
    } else if (c === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      j = Math.min(j + 1, n);
      push("str", sql.slice(i, j));
      i = j;
    } else if (c === '"') {
      const end = sql.indexOf('"', i + 1);
      const j = end < 0 ? n : end + 1;
      push("ident", sql.slice(i, j));
      i = j;
    } else if (c === "$" && /^\$[A-Za-z_]*\$/.test(sql.slice(i))) {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))![0];
      const end = sql.indexOf(tag, i + tag.length);
      const j = end < 0 ? n : end + tag.length;
      push("str", sql.slice(i, j));
      i = j;
    } else if (/[0-9]/.test(c)) {
      let j = i;
      while (j < n && /[0-9._]/.test(sql[j])) j++;
      push("num", sql.slice(i, j));
      i = j;
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(sql[j])) j++;
      const word = sql.slice(i, j);
      push(KEYWORDS.has(word.toUpperCase()) ? "kw" : "text", word);
      i = j;
    } else {
      push("text", c);
      i++;
    }
  }
  return out;
}
