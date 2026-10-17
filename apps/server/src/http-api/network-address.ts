import { isIPv4, isIPv6 } from 'node:net';

export class NetworkAddressError extends Error {
  override readonly name = 'NetworkAddressError';
}

export interface HostAndPort {
  host: string;
  port: string;
}

/** Splits `host:port` or `[ipv6]:port` the way Go's net.SplitHostPort does. */
export function splitHostPort(address: string): HostAndPort {
  if (address.startsWith('[')) {
    const closing = address.indexOf(']');
    if (closing < 0) {
      throw new NetworkAddressError(`address ${address}: missing ']' in address`);
    }
    const rest = address.slice(closing + 1);
    if (!rest.startsWith(':')) {
      throw new NetworkAddressError(`address ${address}: missing port in address`);
    }
    return { host: address.slice(1, closing), port: rest.slice(1) };
  }
  const lastColon = address.lastIndexOf(':');
  if (lastColon < 0) {
    throw new NetworkAddressError(`address ${address}: missing port in address`);
  }
  const host = address.slice(0, lastColon);
  if (host.includes(':')) {
    throw new NetworkAddressError(`address ${address}: too many colons in address`);
  }
  return { host, port: address.slice(lastColon + 1) };
}

function trimBrackets(host: string): string {
  return host.replace(/^\[+|\]+$/g, '');
}

/** `localhost`, any 127.0.0.0/8 address, or ::1 (also IPv4-mapped). */
export function isLoopbackHost(rawHost: string): boolean {
  const host = trimBrackets(rawHost);
  if (host === 'localhost') {
    return true;
  }
  if (isIPv4(host)) {
    return host.startsWith('127.');
  }
  if (isIPv6(host)) {
    const lower = host.toLowerCase();
    if (lower === '::1' || /^(0{1,4}:){7}0{0,3}1$/.test(lower)) {
      return true;
    }
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    return mapped?.[1]?.startsWith('127.') === true;
  }
  return false;
}

/** Refuses to expose the API beyond this machine without a token. */
export function validateBindAddress(listenAddress: string, token: string): void {
  const { host } = splitHostPort(listenAddress);
  if (token === '' && !isLoopbackHost(host)) {
    throw new NetworkAddressError(
      'refusing to listen on a non-local address without --token: anyone who can reach it could read your database schema' +
        ' (and run migrations with --allow-write)',
    );
  }
}

/**
 * Whether a request's Host header names this server: a loopback name, or exactly the host
 * it listens on. A page on another site that tricks the browser into resolving its own name
 * to 127.0.0.1 arrives with that name as Host.
 */
export function isAllowedHostHeader(hostHeader: string, listenAddress: string): boolean {
  let host = hostHeader;
  try {
    host = splitHostPort(hostHeader).host;
  } catch {
    // A Host without a port is compared as it is.
  }
  host = trimBrackets(host);
  if (isLoopbackHost(host)) {
    return true;
  }
  try {
    const listenHost = trimBrackets(splitHostPort(listenAddress).host);
    return host.toLowerCase() === listenHost.toLowerCase();
  } catch {
    return false;
  }
}
