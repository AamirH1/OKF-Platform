import { createReadStream } from 'node:fs';
import net from 'node:net';

export type ScanVerdict = { clean: true } | { clean: false; signature: string };

export interface MalwareScanner {
  /** `none` means scanning is disabled; results are recorded as skipped, not clean. */
  readonly name: 'none' | 'clamav';
  scanFile(filePath: string): Promise<ScanVerdict>;
  ping(): Promise<boolean>;
}

export class ScannerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScannerUnavailableError';
  }
}

export class NoopScanner implements MalwareScanner {
  readonly name = 'none' as const;
  async scanFile(): Promise<ScanVerdict> {
    return { clean: true };
  }
  async ping(): Promise<boolean> {
    return true;
  }
}

/**
 * ClamAV daemon client using the INSTREAM protocol over TCP.
 * Fails closed: any protocol error or size-limit response throws, and the
 * ingestion pipeline treats that as a failed (retryable) scan, never as clean.
 * clamd's `StreamMaxLength` must be at least EXTRACT_MAX_FILE_BYTES.
 */
export class ClamAvScanner implements MalwareScanner {
  readonly name = 'clamav' as const;

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly timeoutMs = 60_000,
  ) {}

  private command(write: (socket: net.Socket) => Promise<void>): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      const chunks: Buffer[] = [];
      socket.setTimeout(this.timeoutMs, () => socket.destroy(new ScannerUnavailableError('ClamAV timed out')));
      socket.on('data', (d: Buffer) => chunks.push(d));
      socket.on('error', (e) => reject(e instanceof ScannerUnavailableError ? e : new ScannerUnavailableError(`ClamAV unavailable: ${e.message}`)));
      socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8').replace(/\0/g, '').trim()));
      socket.on('connect', () => {
        write(socket).catch((e: unknown) => socket.destroy(e as Error));
      });
    });
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.command(async (s) => void s.end('zPING\0'))) === 'PONG';
    } catch {
      return false;
    }
  }

  async scanFile(filePath: string): Promise<ScanVerdict> {
    const reply = await this.command(async (socket) => {
      socket.write('zINSTREAM\0');
      for await (const chunk of createReadStream(filePath, { highWaterMark: 64 * 1024 })) {
        const buf = chunk as Buffer;
        const len = Buffer.alloc(4);
        len.writeUInt32BE(buf.length, 0);
        if (!socket.write(Buffer.concat([len, buf]))) {
          await new Promise((r) => socket.once('drain', r));
        }
      }
      socket.end(Buffer.alloc(4));
    });
    return parseClamdReply(reply);
  }
}

export function parseClamdReply(reply: string): ScanVerdict {
  if (/^stream: OK$/.test(reply)) return { clean: true };
  const found = /^stream: (.+) FOUND$/.exec(reply);
  if (found) return { clean: false, signature: found[1]! };
  throw new ScannerUnavailableError(`Unexpected ClamAV reply: ${reply.slice(0, 200)}`);
}

export function createScanner(kind: 'none' | 'clamav', host: string, port: number): MalwareScanner {
  return kind === 'clamav' ? new ClamAvScanner(host, port) : new NoopScanner();
}
