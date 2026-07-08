import { writeFileSync, mkdirSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(__dirname, '..');
export const UPLOADS_DIR = resolve(PROJECT_ROOT, 'workspace', 'uploads');

function ensureUploadsDir(): void {
  mkdirSync(UPLOADS_DIR, { recursive: true });
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '-');
}

export async function downloadMedia(
  botToken: string,
  fileId: string,
  originalFilename?: string
): Promise<string> {
  ensureUploadsDir();

  // Get file path from Telegram
  const fileInfoUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`;
  const fileInfoRes = await fetch(fileInfoUrl);
  const fileInfo = (await fileInfoRes.json()) as {
    ok: boolean;
    result: { file_path: string };
  };

  if (!fileInfo.ok) {
    throw new Error('Failed to get file info from Telegram');
  }

  const remotePath = fileInfo.result.file_path;
  const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${remotePath}`;
  const fileRes = await fetch(downloadUrl);
  const buf = Buffer.from(await fileRes.arrayBuffer());

  const ext = remotePath.includes('.')
    ? '.' + remotePath.split('.').pop()
    : '';
  const safeName = originalFilename
    ? sanitizeFilename(originalFilename)
    : `file${ext}`;
  const localPath = resolve(UPLOADS_DIR, `${Date.now()}_${safeName}`);
  writeFileSync(localPath, buf);

  logger.debug({ localPath, bytes: buf.length }, 'Media downloaded');
  return localPath;
}

export function buildPhotoMessage(localPath: string, caption?: string): string {
  const parts = [`[Photo attached: ${localPath}]`];
  if (caption) parts.push(caption);
  parts.push('Please analyze this image.');
  return parts.join('\n');
}

export function buildDocumentMessage(
  localPath: string,
  filename: string,
  caption?: string
): string {
  const parts = [`[Document attached: ${localPath} (${filename})]`];
  if (caption) parts.push(caption);
  parts.push('Please review this document.');
  return parts.join('\n');
}

export function buildVideoMessage(
  localPath: string,
  caption?: string
): string {
  const parts = [
    `[Video attached: ${localPath}]`,
    caption ?? '',
    'Please analyze this video. Use the GOOGLE_API_KEY from this project\'s .env file with the Gemini API to process the video content.',
  ].filter(Boolean);
  return parts.join('\n');
}

export function buildVideoNoteMessage(
  localPath: string,
): string {
  return [
    `[Video note (circle) attached: ${localPath}]`,
    'This is a Telegram video circle message. Please analyze the video content.',
    "Use the GOOGLE_API_KEY from this project's .env file with the Gemini API to process the video.",
    'Reply based on what you see and hear in the video.',
  ].join('\n');
}

export function cleanupOldUploads(maxAgeMs = 24 * 60 * 60 * 1000): void {
  ensureUploadsDir();
  const now = Date.now();
  let cleaned = 0;

  try {
    for (const file of readdirSync(UPLOADS_DIR)) {
      const filePath = resolve(UPLOADS_DIR, file);
      const stat = statSync(filePath);
      if (now - stat.mtimeMs > maxAgeMs) {
        unlinkSync(filePath);
        cleaned++;
      }
    }
  } catch {
    // Directory might not exist yet
  }

  if (cleaned > 0) {
    logger.info({ cleaned }, 'Old uploads cleaned up');
  }
}
