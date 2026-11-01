import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ALLOWED_CHAT_IDS, STORE_DIR, TELEGRAM_BOT_TOKEN } from './config.js';
import { initDatabase } from './db.js';
import { runDecaySweep } from './memory.js';
import { cleanupOldUploads } from './media.js';
import { createBot, sendTelegramMessage } from './bot.js';
import { initScheduler, stopScheduler } from './scheduler.js';
import { logger } from './logger.js';

const LOCK_FILE = resolve(STORE_DIR, 'claw.pid');

const BANNER = `
  ██████╗██╗      █████╗ ██╗    ██╗
 ██╔════╝██║     ██╔══██╗██║    ██║
 ██║     ██║     ███████║██║ █╗ ██║
 ██║     ██║     ██╔══██║██║███╗██║
 ╚██████╗███████╗██║  ██║╚███╔███╔╝
  ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝
 Telegram-native multi-agent assistant framework
`;

// Single-instance lock: kill a previous instance and claim the PID file.
function acquireLock(): void {
  mkdirSync(STORE_DIR, { recursive: true });

  if (existsSync(LOCK_FILE)) {
    const oldPid = parseInt(readFileSync(LOCK_FILE, 'utf-8').trim(), 10);
    if (oldPid && !isNaN(oldPid)) {
      try {
        process.kill(oldPid, 0); // Check if alive
        logger.warn({ oldPid }, 'Killing previous instance');
        process.kill(oldPid, 'SIGTERM');
        const start = Date.now();
        while (Date.now() - start < 3000) {
          try {
            process.kill(oldPid, 0);
          } catch {
            break;
          }
        }
      } catch {
        // Process already dead — stale PID file
      }
    }
  }

  writeFileSync(LOCK_FILE, String(process.pid));
}

function releaseLock(): void {
  try {
    unlinkSync(LOCK_FILE);
  } catch {
    // Already cleaned up
  }
}

async function main(): Promise<void> {
  console.log(BANNER);

  if (!TELEGRAM_BOT_TOKEN) {
    logger.error('TELEGRAM_BOT_TOKEN is not set. Copy .env.example to .env and fill it in.');
    process.exit(1);
  }

  if (ALLOWED_CHAT_IDS.length === 0) {
    logger.error('ALLOWED_CHAT_IDS is empty. Set your Telegram chat ID in .env before starting.');
    process.exit(1);
  }

  acquireLock();

  // Init database (sessions, memory, chat history, scheduled tasks)
  initDatabase();

  // Run memory consolidation sweep now and daily thereafter
  runDecaySweep();
  setInterval(runDecaySweep, 24 * 60 * 60 * 1000);

  // Cleanup old uploaded media
  cleanupOldUploads();

  // Create the Telegram bot and the scheduler
  const bot = createBot();
  initScheduler(sendTelegramMessage);

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...');
    stopScheduler();
    await bot.stop();
    releaseLock();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    logger.info('Claw starting...');
    await bot.start();
  } catch (err) {
    logger.error({ err }, 'Failed to start bot. Check TELEGRAM_BOT_TOKEN in .env');
    releaseLock();
    process.exit(1);
  }
}

// Last-resort nets so a single stray rejection somewhere doesn't take the bot down.
// Every message handler already has its own try/catch.
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled promise rejection (kept alive)');
});
process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Uncaught exception (kept alive)');
});

main().catch((err) => {
  logger.fatal({ err }, 'Unhandled error');
  releaseLock();
  process.exit(1);
});
