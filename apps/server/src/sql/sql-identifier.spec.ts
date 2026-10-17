import { quoteIdentifier } from './sql-identifier';

describe('quoteIdentifier', () => {
  it.each([
    ['users', 'users'],
    ['user', '"user"'],
    ['Order', '"Order"'],
    ['order', '"order"'],
    ['my table', '"my table"'],
    ['we"ird', '"we""ird"'],
    ['_ok1', '_ok1'],
    ['1abc', '"1abc"'],
  ])('quotes %p only when it has to', (name, expected) => {
    expect(quoteIdentifier(name)).toBe(expected);
  });
});
