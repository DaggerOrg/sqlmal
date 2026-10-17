import { describe, expect, it } from 'vitest';
import {
  capitalizeFirstLetter,
  formatByteSize,
  formatCompactCount,
  formatServerVersion,
  formatVersion,
  humanizeMigrationName,
  pluralize,
} from './format';

describe('format', () => {
  it('formats byte sizes with a unit', () => {
    expect(formatByteSize(512)).toBe('512 B');
    expect(formatByteSize(2048)).toBe('2.0 KB');
    expect(formatByteSize(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatByteSize(300 * 1024 * 1024)).toBe('300 MB');
  });

  it('formats large counts compactly', () => {
    expect(formatCompactCount(999)).toBe('999');
    expect(formatCompactCount(1500)).toBe('1.5k');
    expect(formatCompactCount(25000)).toBe('25k');
    expect(formatCompactCount(2_400_000)).toBe('2.4M');
  });

  it('pads sequential versions but not timestamps', () => {
    expect(formatVersion(7)).toBe('0007');
    expect(formatVersion(20261010120000)).toBe('20261010120000');
  });

  it('pluralises', () => {
    expect(pluralize(1, 'table')).toBe('1 table');
    expect(pluralize(3, 'table')).toBe('3 tables');
    expect(pluralize(2, 'index', 'indexes')).toBe('2 indexes');
  });

  it('humanises migration names and capitalises notes', () => {
    expect(humanizeMigrationName('create_order_items')).toBe('create order items');
    expect(capitalizeFirstLetter('after rolling back')).toBe('After rolling back');
    expect(capitalizeFirstLetter('')).toBe('');
  });

  it('prefixes release versions with v but leaves build labels alone', () => {
    expect(formatServerVersion('1.2.0')).toBe('v1.2.0');
    expect(formatServerVersion('dev')).toBe('dev');
  });
});
