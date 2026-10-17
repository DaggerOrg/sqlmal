import { isAllowedHostHeader, splitHostPort, validateBindAddress } from './network-address';
import { scrubSecrets } from './secret-scrubber';

describe('validateBindAddress', () => {
  it.each([
    ['127.0.0.1:8484', ''],
    ['localhost:8484', ''],
    ['[::1]:8484', ''],
    ['0.0.0.0:8484', 'tok'],
    ['192.168.1.5:8484', 'tok'],
  ])('allows %s with token %p', (address, token) => {
    expect(() => validateBindAddress(address, token)).not.toThrow();
  });

  it.each(['0.0.0.0:8484', ':8484', '192.168.1.5:8484', 'example.com:80'])(
    'refuses %s without a token',
    (address) => {
      expect(() => validateBindAddress(address, '')).toThrow(/without --token/);
    },
  );

  it('rejects an address without a port', () => {
    expect(() => splitHostPort('8484')).toThrow('missing port');
  });
});

describe('isAllowedHostHeader', () => {
  it.each([
    ['localhost:8484', true],
    ['127.0.0.1:8484', true],
    ['[::1]:8484', true],
    ['attacker.example:8484', false],
    ['evil.test', false],
  ])('treats Host %s as allowed: %p', (host, isAllowed) => {
    expect(isAllowedHostHeader(host, '127.0.0.1:8484')).toBe(isAllowed);
  });

  it('accepts the bind host itself', () => {
    expect(isAllowedHostHeader('db-box.lan:8484', 'DB-BOX.lan:8484')).toBe(true);
  });
});

describe('scrubSecrets', () => {
  it('does not leak credentials', () => {
    const scrubbed = scrubSecrets(
      'failed to connect to postgres://admin:hunter2@db.internal:5432/shop and password=hunter2 was wrong',
    );
    expect(scrubbed).not.toContain('hunter2');
  });
});
