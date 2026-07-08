import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnvFile } from './env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const env = readEnvFile();

// Paths
export const PROJECT_ROOT = resolve(__dirname, '..');
export const STORE_DIR = resolve(PROJECT_ROOT, 'store');

// Telegram bot (grammY / Bot API)
export const TELEGRAM_BOT_TOKEN = env['TELEGRAM_BOT_TOKEN'] ?? '';
// Support both ALLOWED_CHAT_ID (single) and ALLOWED_CHAT_IDS (comma-separated).
// Empty list = first-run mode (bot replies to everyone until you lock it down).
const rawChatIds = env['ALLOWED_CHAT_IDS'] ?? env['ALLOWED_CHAT_ID'] ?? '';
export const ALLOWED_CHAT_IDS: string[] = rawChatIds
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

// Optional admin chat id used by the crew orchestrator for out-of-band notifications
export const ADMIN_CHAT_ID = env['ADMIN_CHAT_ID'] ?? '';

// Voice — speech to text (OpenAI Whisper)
export const OPENAI_API_KEY = env['OPENAI_API_KEY'] ?? '';

// Voice — text to speech (ElevenLabs)
export const ELEVENLABS_API_KEY = env['ELEVENLABS_API_KEY'] ?? '';
export const ELEVENLABS_VOICE_ID = env['ELEVENLABS_VOICE_ID'] ?? '';

// Multimodal / video understanding (Google Gemini)
export const GOOGLE_API_KEY = env['GOOGLE_API_KEY'] ?? '';

// Optional Telegram user account (MTProto) — multi-account userbot support.
// Only needed if you use the optional tg-user-client integration.
export const TG_API_ID = parseInt(env['TG_API_ID'] ?? env['TELEGRAM_API_ID'] ?? '0', 10);
export const TG_API_HASH = env['TG_API_HASH'] ?? env['TELEGRAM_API_HASH'] ?? '';
export const TG_SESSION_STRING = env['TG_SESSION_STRING'] ?? '';

// Multi-account: TG_SESSION_STRING (account 1), TG_SESSION_STRING_2, TG_SESSION_STRING_3, ...
export function getTgSessionString(account: number = 1): string {
  if (account === 1) return TG_SESSION_STRING;
  return env[`TG_SESSION_STRING_${account}`] ?? '';
}

export function listTgAccounts(): number[] {
  const accounts: number[] = [];
  if (TG_SESSION_STRING) accounts.push(1);
  for (let i = 2; i <= 10; i++) {
    if (env[`TG_SESSION_STRING_${i}`]) accounts.push(i);
  }
  return accounts;
}

// Limits
export const MAX_MESSAGE_LENGTH = 4096;
export const TYPING_REFRESH_MS = 4000;
