/**
 * Optional Telegram user-account (MTProto) client.
 *
 * The main bot uses the Bot API (grammY). This module is for the cases the Bot
 * API can't cover — reading full dialog history, acting as a userbot, or driving
 * multiple accounts. It is intentionally decoupled from the core: import it only
 * if you need it, and provide TG_API_ID / TG_API_HASH / TG_SESSION_STRING in .env.
 *
 * Multi-account: pass an account number; sessions are read from
 * TG_SESSION_STRING (account 1), TG_SESSION_STRING_2, TG_SESSION_STRING_3, ...
 */

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { TG_API_ID, TG_API_HASH, getTgSessionString, listTgAccounts } from '../config.js';

export async function createUserClient(account: number = 1): Promise<TelegramClient> {
  const sessionString = getTgSessionString(account);
  if (!TG_API_ID || !TG_API_HASH || !sessionString) {
    const suffix = account === 1 ? '' : `_${account}`;
    throw new Error(
      `TG_API_ID, TG_API_HASH, and TG_SESSION_STRING${suffix} must be set in .env. ` +
        `Generate a session string once with a login script, then store it in .env.`
    );
  }
  const session = new StringSession(sessionString);
  const client = new TelegramClient(session, TG_API_ID, TG_API_HASH, {
    connectionRetries: 3,
  });
  await client.connect();
  return client;
}

export { listTgAccounts };
