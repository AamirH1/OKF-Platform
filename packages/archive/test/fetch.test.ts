import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkImportUrlSyntax, isPrivateAddress, safeFetchToFile, UrlGuardError } from '../src';

const strict = { allowHttp: false, allowedHosts: [], allowPrivate: false };

describe('isPrivateAddress', () => {
  it.each([
    ['127.0.0.1', true], ['10.1.2.3', true], ['172.31.255.255', true], ['192.168.1.1', true], ['169.254.169.254', true],
    ['100.64.0.1', true], ['0.0.0.0', true], ['224.0.0.1', true], ['::1', true], ['fe80::1', true], ['fd00::1', true],
    ['::ffff:127.0.0.1', true], ['::ffff:7f00:1', true], ['64:ff9b::a9fe:a9fe', true], ['64:ff9b::808:808', false], ['64:ff9b::169.254.169.254', true],
    ['8.8.8.8', false], ['1.1.1.1', false], ['2606:4700:4700::1111', false], ['not-an-ip', true],
  ])('%s → %s', (ip, expected) => {
    expect(isPrivateAddress(ip)).toBe(expected);
  });
});

describe('checkImportUrlSyntax', () => {
  it.each([
    ['http://example.com/a.zip', /Only https/],
    ['https://user:pw@example.com/a.zip', /credentials/],
    ['https://localhost/a.zip', /Internal/],
    ['https://metadata.google.internal/x', /Internal/],
    ['https://127.0.0.1/a.zip', /Private/],
    ['https://[::1]/a.zip', /Private/],
    ['https://169.254.169.254/latest/meta-data', /Private/],
    ['file:///etc/passwd', /Only https/],
    ['gopher://example.com', /Only https/],
    ['not a url', /valid URL/],
  ])('rejects %s', (url, msg) => {
    expect(() => checkImportUrlSyntax(url, strict)).toThrow(msg);
  });

  it('enforces the allow-list with subdomains', () => {
    const opts = { ...strict, allowedHosts: ['github.com'] };
    expect(checkImportUrlSyntax('https://codeload.github.com/x.tar.gz', opts).hostname).toBe('codeload.github.com');
    expect(() => checkImportUrlSyntax('https://evilgithub.com/x', opts)).toThrow(/allow-list/);
  });
});

describe('safeFetchToFile', () => {
  let server: http.Server;
  let base: string;
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'okf-fetch-'));
    server = http.createServer((req, res) => {
      if (req.url === '/ok') return res.end('bundle-bytes');
      if (req.url === '/redirect-internal') {
        res.writeHead(302, { location: 'http://127.0.0.1:1/secret' });
        return res.end();
      }
      if (req.url === '/big') {
        res.writeHead(200);
        return res.end(Buffer.alloc(2048));
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.close();
    await rm(dir, { recursive: true, force: true });
  });

  const opts = { allowHttp: true, allowedHosts: [], allowPrivate: false, maxBytes: 1024, timeoutMs: 5000 };

  it('refuses hosts that resolve to private addresses (checked at connect time)', async () => {
    // "localhost" is caught syntactically; use a name that only DNS reveals as loopback.
    const url = base.replace('localhost', 'localtest.me');
    const err = await safeFetchToFile(url + '/ok', path.join(dir, 'a'), opts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UrlGuardError);
    expect((err as Error).message).toMatch(/non-public|resolve|fetch/);
  });

  it('downloads, hashes and enforces limits when private networks are allowed (dev)', async () => {
    const dev = { ...opts, allowPrivate: true };
    const r = await safeFetchToFile(`${base}/ok`, path.join(dir, 'b'), dev);
    expect(r.bytes).toBe(12);
    expect(await readFile(path.join(dir, 'b'), 'utf8')).toBe('bundle-bytes');
    await expect(safeFetchToFile(`${base}/big`, path.join(dir, 'c'), dev)).rejects.toThrow(/larger than/);
    await expect(safeFetchToFile(`${base}/missing`, path.join(dir, 'd'), dev)).rejects.toThrow(/HTTP 404/);
  });

  it('re-validates redirect targets', async () => {
    const err = await safeFetchToFile(`${base}/redirect-internal`, path.join(dir, 'e'), { ...opts, allowPrivate: true, allowedHosts: ['localhost'] }).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/allow-list/);
  });
});
