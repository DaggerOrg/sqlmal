import { describe, expect, it } from 'vitest';
import { splitTokensIntoLines, tokenizeSql } from './sql-tokenizer';

const describeTokens = (sql: string): string[] =>
  tokenizeSql(sql)
    .filter((token) => token.kind !== 'text')
    .map((token) => `${token.kind}:${token.text}`);

const joinTokens = (sql: string): string =>
  tokenizeSql(sql)
    .map((token) => token.text)
    .join('');

describe('tokenizeSql', () => {
  it('marks keywords, strings, numbers and comments', () => {
    expect(describeTokens("CREATE TABLE t (id int DEFAULT 5, n text DEFAULT 'it''s'); -- done")).toEqual([
      'keyword:CREATE',
      'keyword:TABLE',
      'keyword:int',
      'keyword:DEFAULT',
      'number:5',
      'keyword:text',
      'keyword:DEFAULT',
      "string:'it''s'",
      'comment:-- done',
    ]);
  });

  it('does not highlight keywords inside strings, comments or quoted identifiers', () => {
    expect(describeTokens("INSERT INTO t VALUES ('DROP TABLE x')")).toEqual([
      'keyword:INSERT',
      'keyword:INTO',
      'keyword:VALUES',
      "string:'DROP TABLE x'",
    ]);
    expect(describeTokens('/* DROP TABLE x */ SELECT 1')).toEqual([
      'comment:/* DROP TABLE x */',
      'keyword:SELECT',
      'number:1',
    ]);
    expect(describeTokens('SELECT "select" FROM t')).toEqual([
      'keyword:SELECT',
      'identifier:"select"',
      'keyword:FROM',
    ]);
  });

  it('round-trips: the tokens always concatenate back to the input', () => {
    const sql =
      '-- header\nCREATE TABLE "We""ird" (a int);\nDO $$ BEGIN PERFORM 1; END $$;\nSELECT \'unterminated';
    expect(joinTokens(sql)).toBe(sql);
  });

  it('is case-insensitive for keywords but keeps the original text', () => {
    expect(describeTokens('select 1 from T')).toEqual(['keyword:select', 'number:1', 'keyword:from']);
  });

  it('copes with unterminated input', () => {
    for (const sql of ["'oops", '"oops', '/* oops', '$$oops', '$']) expect(joinTokens(sql)).toBe(sql);
  });
});

describe('splitTokensIntoLines', () => {
  it('splits a multi-line comment across lines and keeps empty lines', () => {
    const lines = splitTokensIntoLines(tokenizeSql('/* a\nb */\n\nSELECT 1'));
    expect(lines).toHaveLength(4);
    expect(lines[0]).toEqual([{ kind: 'comment', text: '/* a' }]);
    expect(lines[1]).toEqual([{ kind: 'comment', text: 'b */' }]);
    expect(lines[2]).toEqual([]);
    expect(lines[3]?.[0]).toEqual({ kind: 'keyword', text: 'SELECT' });
  });
});
