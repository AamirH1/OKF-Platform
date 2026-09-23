import zlib from 'node:zlib';

/** Minimal archive writers that can produce malicious entries real tools refuse to create. */

export interface ZipEntry {
  name: string;
  data?: Buffer | string;
  /** Unix mode (e.g. 0o120777 for a symlink); stored in external attributes. */
  mode?: number;
  deflate?: boolean;
  encrypted?: boolean;
}

export function buildZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? '', 'utf8');
    const packed = e.deflate ? zlib.deflateRawSync(raw) : raw;
    // Traditional PKWARE encryption prefixes the data with a 12-byte header.
    const body = e.encrypted ? Buffer.concat([Buffer.alloc(12, 0xaa), packed]) : packed;
    const crc = zlib.crc32(raw);
    const flags = 0x0800 | (e.encrypted ? 0x1 : 0);
    const method = e.deflate ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by Unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((e.mode ?? (e.name.endsWith('/') ? 0o040755 : 0o100644)) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

export interface TarEntry {
  name: string;
  data?: string | Buffer;
  /** ustar typeflag: '0' file, '1' hardlink, '2' symlink, '3' char device, '5' directory. */
  type?: '0' | '1' | '2' | '3' | '5';
  linkname?: string;
}

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, '0') + '\0';
}

export function buildTar(entries: TarEntry[], gzip = false): Buffer {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? '', 'utf8');
    const h = Buffer.alloc(512);
    h.write(e.name, 0, 100, 'utf8');
    h.write(octal(0o644, 8), 100, 'ascii');
    h.write(octal(0, 8), 108, 'ascii');
    h.write(octal(0, 8), 116, 'ascii');
    h.write(octal(e.type === '0' || !e.type ? data.length : 0, 12), 124, 'ascii');
    h.write(octal(0, 12), 136, 'ascii');
    h.fill(' ', 148, 156);
    h.write(e.type ?? '0', 156, 'ascii');
    if (e.linkname) h.write(e.linkname, 157, 100, 'utf8');
    h.write('ustar\u000000', 257, 'ascii');
    let sum = 0;
    for (const b of h) sum += b;
    h.write(octal(sum, 7) + ' ', 148, 'ascii');
    blocks.push(h);
    if (e.type === '0' || !e.type) {
      blocks.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
    }
  }
  blocks.push(Buffer.alloc(1024));
  const tar = Buffer.concat(blocks);
  return gzip ? zlib.gzipSync(tar) : tar;
}
