import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = resolve(__dirname, '..', 'workspace', 'uploads');

function ensureUploadsDir(): void {
  mkdirSync(UPLOADS_DIR, { recursive: true });
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '-');
}

/**
 * Download a file from any URL and save locally.
 * Used by pluggable integrations and non-Telegram media sources.
 */
export async function downloadUrl(url: string, filename: string): Promise<string> {
  ensureUploadsDir();

  // Timeout so a hung CDN URL can't block the message handler forever.
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) {
    throw new Error(`Failed to download: ${res.status} ${res.statusText}`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  const safeName = sanitizeFilename(filename);
  // Random suffix avoids collisions when several files share a name within the same millisecond.
  const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const localPath = resolve(UPLOADS_DIR, `${unique}_${safeName}`);
  writeFileSync(localPath, buf);

  logger.debug({ localPath, bytes: buf.length, url: url.slice(0, 80) }, 'URL media downloaded');
  return localPath;
}
