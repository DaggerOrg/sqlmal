// A small SQL tokenizer for display. It highlights, it does not parse.

export type SqlTokenKind = 'keyword' | 'string' | 'comment' | 'number' | 'identifier' | 'text';

export interface SqlToken {
  kind: SqlTokenKind;
  text: string;
}

const SQL_KEYWORDS = new Set(
  `ADD ALTER AND AS ASC BEGIN BETWEEN BIGINT BIGSERIAL BOOLEAN BY CASCADE CASE CHAR CHECK COLUMN COMMIT CONCURRENTLY CONSTRAINT CREATE CURRENT_TIMESTAMP DATA DEFAULT DELETE DESC DISTINCT DROP ELSE END ENUM EXISTS FALSE FOREIGN FROM GENERATED IF IN INDEX INSERT INT INTEGER INTO IS JOIN KEY LIMIT NOT NOW NULL NULLIF ON ONLY OR ORDER PRIMARY REFERENCES RENAME RESTRICT SELECT SERIAL SET SMALLINT SMALLSERIAL TABLE TEXT THEN TIMESTAMPTZ TO TRUE TRUNCATE TYPE UNIQUE UPDATE USING VALUE VALUES VARCHAR VIEW WHEN WHERE WITH`.split(
    /\s+/,
  ),
);

const DOLLAR_QUOTE_TAG = /^\$[A-Za-z_]*\$/;

/** Splits SQL into tokens. Concatenating the token texts always gives back the input. */
export function tokenizeSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  const pushToken = (kind: SqlTokenKind, text: string): void => {
    if (!text) return;
    const lastToken = tokens.at(-1);
    if (lastToken?.kind === kind && (kind === 'text' || kind === 'comment')) lastToken.text += text;
    else tokens.push({ kind, text });
  };
  const characterAt = (index: number): string => sql.charAt(index);

  let position = 0;
  const length = sql.length;
  while (position < length) {
    const character = characterAt(position);
    if (character === '-' && characterAt(position + 1) === '-') {
      let end = position;
      while (end < length && characterAt(end) !== '\n') end++;
      pushToken('comment', sql.slice(position, end));
      position = end;
    } else if (character === '/' && characterAt(position + 1) === '*') {
      const closeIndex = sql.indexOf('*/', position + 2);
      const end = closeIndex < 0 ? length : closeIndex + 2;
      pushToken('comment', sql.slice(position, end));
      position = end;
    } else if (character === "'") {
      let end = position + 1;
      while (end < length) {
        if (characterAt(end) === "'") {
          if (characterAt(end + 1) === "'") {
            end += 2;
            continue;
          }
          break;
        }
        end++;
      }
      end = Math.min(end + 1, length);
      pushToken('string', sql.slice(position, end));
      position = end;
    } else if (character === '"') {
      const closeIndex = sql.indexOf('"', position + 1);
      const end = closeIndex < 0 ? length : closeIndex + 1;
      pushToken('identifier', sql.slice(position, end));
      position = end;
    } else if (character === '$' && DOLLAR_QUOTE_TAG.test(sql.slice(position))) {
      const tag = DOLLAR_QUOTE_TAG.exec(sql.slice(position))?.[0] ?? '$$';
      const closeIndex = sql.indexOf(tag, position + tag.length);
      const end = closeIndex < 0 ? length : closeIndex + tag.length;
      pushToken('string', sql.slice(position, end));
      position = end;
    } else if (/[0-9]/.test(character)) {
      let end = position;
      while (end < length && /[0-9._]/.test(characterAt(end))) end++;
      pushToken('number', sql.slice(position, end));
      position = end;
    } else if (/[A-Za-z_]/.test(character)) {
      let end = position;
      while (end < length && /[A-Za-z0-9_$]/.test(characterAt(end))) end++;
      const word = sql.slice(position, end);
      pushToken(SQL_KEYWORDS.has(word.toUpperCase()) ? 'keyword' : 'text', word);
      position = end;
    } else {
      pushToken('text', character);
      position++;
    }
  }
  return tokens;
}

/** Splits tokens into lines, so each line can carry a number. */
export function splitTokensIntoLines(tokens: SqlToken[]): SqlToken[][] {
  const lines: SqlToken[][] = [[]];
  for (const token of tokens) {
    token.text.split('\n').forEach((part, partIndex) => {
      if (partIndex > 0) lines.push([]);
      if (part) lines.at(-1)?.push({ kind: token.kind, text: part });
    });
  }
  return lines;
}
