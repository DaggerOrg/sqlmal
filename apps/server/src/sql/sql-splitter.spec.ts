import { normalizeStatement, splitSqlStatements } from './sql-splitter';

function splitTexts(source: string): string[] {
  return splitSqlStatements(source).map((statement) => statement.sql);
}

describe('splitSqlStatements', () => {
  it('splits on semicolons and trims each statement', () => {
    expect(splitTexts('CREATE TABLE a (id int);\n\nCREATE TABLE b (id int);')).toEqual([
      'CREATE TABLE a (id int)',
      'CREATE TABLE b (id int)',
    ]);
  });

  it.each([
    ['a string', "INSERT INTO t VALUES ('a;b');SELECT 1"],
    ['an escaped quote', "INSERT INTO t VALUES ('it''s; fine');SELECT 1"],
    ['an E string', "INSERT INTO t VALUES (E'a\\';b');SELECT 1"],
    ['an identifier', 'SELECT "weird;name" FROM t;SELECT 1'],
    ['a line comment', 'SELECT 1 -- ; not a split\n;SELECT 2'],
    ['a block comment', 'SELECT 1 /* ; /* nested ; */ ; */ ;SELECT 2'],
    ['a dollar quote', 'CREATE FUNCTION f() RETURNS void AS $$ BEGIN PERFORM 1; END; $$ LANGUAGE plpgsql;SELECT 2'],
    ['a tagged dollar quote', 'DO $body$ BEGIN PERFORM 1; END $body$;SELECT 2'],
  ])('does not split on a semicolon inside %s', (_label, source) => {
    expect(splitSqlStatements(source)).toHaveLength(2);
  });

  it('reports the line where each statement starts', () => {
    const statements = splitSqlStatements('-- header\n\nCREATE TABLE a (\n  id int\n);\n\nDROP TABLE a;');
    expect(statements.map((statement) => statement.line)).toEqual([3, 7]);
  });

  it('keeps line numbers right after a multi-line dollar-quoted body', () => {
    const statements = splitSqlStatements('SELECT $$a\nb\nc$$;\nSELECT 2;');
    expect(statements[1]!.line).toBe(4);
  });

  it.each(["SELECT 'oops", 'SELECT "oops', 'SELECT $$oops', 'SELECT /* oops', '$'])(
    'returns on unterminated input %p',
    (source) => {
      expect(() => splitSqlStatements(source)).not.toThrow();
    },
  );
});

describe('normalizeStatement', () => {
  it('blanks string literals, uppercases and collapses whitespace', () => {
    expect(normalizeStatement("insert  into t\n values ('DROP TABLE x', 'it''s')")).toBe(
      "INSERT INTO T VALUES ('', '')",
    );
  });
});
