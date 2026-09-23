import { createHash } from 'node:crypto';
import dns from 'node:dns';
import { createWriteStream } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export class UrlGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UrlGuardError';
  }
}

export interface UrlGuardOptions {
  allowHttp: boolean;
  /** If non-empty, the hostname must equal one of these or be a subdomain of one. */
  allowedHosts: string[];
  /** Never enable in production: permits loopback/private/link-local targets. */
  allowPrivate: boolean;
}

/** Non-public address ranges (RFC 6890 special-purpose registries, plus cloud metadata). */
const BLOCKED = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) {
  BLOCKED.addSubnet(addr, prefix, 'ipv4');
}
for (const [addr, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32], ['100::', 64], ['2001::', 23],
] as const) {
  BLOCKED.addSubnet(addr, prefix, 'ipv6');
}

/** Whether an IP literal is non-public. IPv4-mapped/NAT64 IPv6 addresses are checked as IPv4. */
export function isPrivateAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return BLOCKED.check(ip, 'ipv4');
  if (family === 6) {
    const lower = ip.toLowerCase();
    const mapped = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return BLOCKED.check(mapped[1]!, 'ipv4');
    const hexMapped = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
    if (hexMapped) {
      const n = (parseInt(hexMapped[1]!, 16) << 16) | parseInt(hexMapped[2]!, 16);
      return BLOCKED.check([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'), 'ipv4');
    }
    return BLOCKED.check(ip, 'ipv6');
  }
  return true;
}

const BLOCKED_HOSTNAMES = /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/i;

/** Static checks that need no DNS: scheme, credentials, host allow-list, IP literals. */
export function checkImportUrlSyntax(raw: string, opts: UrlGuardOptions): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UrlGuardError('Not a valid URL.');
  }
  if (url.protocol !== 'https:' && !(opts.allowHttp && url.protocol === 'http:')) {
    throw new UrlGuardError(opts.allowHttp ? 'Only http and https URLs are allowed.' : 'Only https URLs are allowed.');
  }
  if (url.username || url.password) throw new UrlGuardError('URLs with credentials are not allowed.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (opts.allowedHosts.length > 0 && !opts.allowedHosts.some((h) => host === h || host.endsWith(`.${h}`))) {
    throw new UrlGuardError(`Host ${host} is not in the import allow-list.`);
  }
  if (!opts.allowPrivate) {
    if (BLOCKED_HOSTNAMES.test(host)) throw new UrlGuardError('Internal hostnames are not allowed.');
    if (net.isIP(host) && isPrivateAddress(host)) throw new UrlGuardError('Private, loopback and link-local addresses are not allowed.');
  }
  return url;
}

export interface SafeFetchOptions extends UrlGuardOptions {
  maxBytes: number;
  timeoutMs: number;
  maxRedirects?: number;
}

export interface SafeFetchResult {
  bytes: number;
  sha256: string;
  contentType: string | null;
  finalUrl: string;
}

/**
 * Download a URL to a file with SSRF protection. The IP check runs inside the socket's DNS
 * lookup, i.e. on the exact address being connected to, which closes the DNS-rebinding
 * window between "check" and "connect". Redirects are followed manually and re-validated.
 */
export async function safeFetchToFile(raw: string, dest: string, opts: SafeFetchOptions): Promise<SafeFetchResult> {
  const deadline = Date.now() + opts.timeoutMs;
  let url = checkImportUrlSyntax(raw, opts);
  for (let hop = 0; hop <= (opts.maxRedirects ?? 3); hop++) {
    const res = await request(url, opts, deadline);
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      url = checkImportUrlSyntax(new URL(res.headers.location, url).toString(), opts);
      continue;
    }
    if (status !== 200) {
      res.resume();
      throw new UrlGuardError(`Remote server responded with HTTP ${status}.`);
    }
    const declared = Number(res.headers['content-length'] ?? NaN);
    if (Number.isFinite(declared) && declared > opts.maxBytes) {
      res.destroy();
      throw new UrlGuardError(`Remote file is larger than the ${opts.maxBytes}-byte import limit.`);
    }
    const hash = createHash('sha256');
    let bytes = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _e, cb) {
        bytes += chunk.length;
        if (bytes > opts.maxBytes) return cb(new UrlGuardError(`Remote file is larger than the ${opts.maxBytes}-byte import limit.`));
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    const timer = setTimeout(() => res.destroy(new UrlGuardError('Import timed out.')), Math.max(1, deadline - Date.now()));
    try {
      await pipeline(res, meter, createWriteStream(dest, { mode: 0o600 }));
    } finally {
      clearTimeout(timer);
    }
    return { bytes, sha256: hash.digest('hex'), contentType: (res.headers['content-type'] as string | undefined) ?? null, finalUrl: url.toString() };
  }
  throw new UrlGuardError('Too many redirects.');
}

function request(url: URL, opts: SafeFetchOptions, deadline: number): Promise<http.IncomingMessage> {
  const guardedLookup: net.LookupFunction = (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, '', 0);
      const list = addresses as dns.LookupAddress[];
      if (!opts.allowPrivate && list.some((a) => isPrivateAddress(a.address))) {
        return callback(new UrlGuardError(`${hostname} resolves to a non-public address.`), '', 0);
      }
      const first = list[0];
      if (!first) return callback(new UrlGuardError(`${hostname} did not resolve.`), '', 0);
      if ((options as { all?: boolean }).all) (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
      else callback(null, first.address, first.family);
    });
  };
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(url, {
      method: 'GET',
      lookup: guardedLookup,
      headers: { 'user-agent': 'okf-platform-importer/1.0', accept: '*/*' },
      timeout: Math.max(1, deadline - Date.now()),
      agent: false,
    });
    req.on('response', resolve);
    req.on('timeout', () => req.destroy(new UrlGuardError('Import timed out.')));
    req.on('error', (e) => reject(e instanceof UrlGuardError ? e : new UrlGuardError(`Could not fetch URL: ${e.message}`)));
    req.end();
  });
}
