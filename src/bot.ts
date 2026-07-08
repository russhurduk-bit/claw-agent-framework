import { Bot, Context, InputFile } from 'grammy';
import {
  TELEGRAM_BOT_TOKEN,
  ALLOWED_CHAT_IDS,
  MAX_MESSAGE_LENGTH,
  TYPING_REFRESH_MS,
} from './config.js';
import {
  getSession, setSession, clearSession, getRecentMemories,
  listTasks, deleteTask, setTaskStatus, getPermanentMemories,
  saveChatMessage, clearChatHistory,
} from './db.js';
import { runAgent, type ImageAttachment } from './agent.js';
import { buildMemoryContext, saveConversationTurn, rememberExplicit, getMemoryStatsForChat } from './memory.js';
import { transcribeAudio, synthesizeSpeech, voiceCapabilities } from './voice.js';
import { downloadMedia, buildDocumentMessage, buildVideoNoteMessage } from './media.js';
import { enrichMessageWithYouTube } from './youtube.js';

import { execSync } from 'node:child_process';
import { existsSync, statSync, unlinkSync } from 'node:fs';
import { logger } from './logger.js';

// Voice-reply mode toggle (in-memory, per chat)
const voiceEnabledChats = new Set<string>();

// --- Telegram HTML formatter ---
// Converts a subset of Markdown to Telegram-safe HTML, protecting code blocks and URLs.

export function formatForTelegram(text: string): string {
  // Protect code blocks
  const codeBlocks: string[] = [];
  let result = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
    const escaped = escapeHtml(code.trimEnd());
    const tag = lang ? `<pre><code class="language-${lang}">${escaped}</code></pre>` : `<pre>${escaped}</pre>`;
    codeBlocks.push(tag);
    return `%%CODEBLOCK_${codeBlocks.length - 1}%%`;
  });

  // Protect inline code
  const inlineCode: string[] = [];
  result = result.replace(/`([^`]+)`/g, (_m, code) => {
    inlineCode.push(`<code>${escapeHtml(code)}</code>`);
    return `%%INLINE_${inlineCode.length - 1}%%`;
  });

  // Protect bare URLs (before markdown formatting mangles underscores)
  const bareUrls: string[] = [];
  result = result.replace(/https?:\/\/[^\s<>)\]]+/g, (url) => {
    bareUrls.push(url);
    return `%%URL_${bareUrls.length - 1}%%`;
  });

  // Escape HTML in remaining text (not in placeholders)
  result = result.replace(/%%(?:CODEBLOCK|INLINE)_\d+%%|[^]+?/g, (match) => {
    if (match.startsWith('%%')) return match;
    return escapeHtmlText(match);
  });

  // Headings
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');

  // Bold
  result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  result = result.replace(/__(.+?)__/g, '<b>$1</b>');

  // Italic
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<i>$1</i>');
  result = result.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, '<i>$1</i>');

  // Strikethrough
  result = result.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // Links
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Checkboxes
  result = result.replace(/^- \[ \]/gm, '☐');
  result = result.replace(/^- \[x\]/gm, '☑');

  // Strip horizontal rules
  result = result.replace(/^---+$/gm, '');
  result = result.replace(/^\*\*\*+$/gm, '');

  // Restore protected tokens
  result = result.replace(/%%CODEBLOCK_(\d+)%%/g, (_m, i) => codeBlocks[parseInt(i)]);
  result = result.replace(/%%INLINE_(\d+)%%/g, (_m, i) => inlineCode[parseInt(i)]);
  result = result.replace(/%%URL_(\d+)%%/g, (_m, i) => bareUrls[parseInt(i)]);

  return result.trim();
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeHtmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// --- Message splitter (Telegram caps messages at 4096 chars) ---

export function splitMessage(text: string, limit = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    let splitIdx = remaining.lastIndexOf('\n', limit);
    if (splitIdx <= 0) splitIdx = remaining.lastIndexOf(' ', limit);
    if (splitIdx <= 0) splitIdx = limit;

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return chunks;
}

// --- Auth check ---

function isAuthorised(chatId: number): boolean {
  if (ALLOWED_CHAT_IDS.length === 0) return true; // first-run mode: reply to everyone
  return ALLOWED_CHAT_IDS.includes(String(chatId));
}

// --- Main message handler ---

async function handleMessage(
  ctx: Context,
  rawText: string,
  forceVoiceReply = false,
  images?: ImageAttachment[]
): Promise<void> {
  const chatId = String(ctx.chat?.id);
  if (!chatId || !ctx.chat) return;

  if (!isAuthorised(ctx.chat.id)) {
    return; // silently ignore unauthorised chats
  }

  // Build memory context (permanent facts + targeted recall + recent history)
  const memoryCtx = buildMemoryContext(chatId, rawText);
  const fullMessage = memoryCtx
    ? `${memoryCtx}\n\n---\n[CURRENT USER MESSAGE — respond to THIS, not to memory above]:\n${rawText}`
    : rawText;

  // Resume the existing Claude session for this chat, if any
  const sessionId = getSession(chatId);

  // Typing indicator loop
  const sendTyping = () => {
    ctx.api.sendChatAction(ctx.chat!.id, 'typing').catch(() => {});
  };
  sendTyping();
  const typingInterval = setInterval(sendTyping, TYPING_REFRESH_MS);

  saveChatMessage(chatId, 'user', rawText);

  try {
    let { text, newSessionId } = await runAgent(fullMessage, sessionId, sendTyping, images);

    // If the resumed session crashed, retry fresh (memory still carries over)
    if (text === null && sessionId) {
      logger.info({ chatId }, 'Retrying without session after crash');
      const retry = await runAgent(fullMessage, undefined, sendTyping, images);
      text = retry.text;
      newSessionId = retry.newSessionId;
    }

    if (newSessionId) setSession(chatId, newSessionId);

    if (!text) {
      await ctx.reply('No response from the agent.');
      return;
    }

    saveChatMessage(chatId, 'assistant', text);
    saveConversationTurn(chatId, rawText, text);

    // Voice reply?
    const caps = voiceCapabilities();
    const shouldVoice = caps.tts && (forceVoiceReply || voiceEnabledChats.has(chatId));

    if (shouldVoice) {
      try {
        const audio = await synthesizeSpeech(text.slice(0, 4000));
        await ctx.replyWithVoice(new InputFile(audio, 'reply.mp3'));
        if (text.length > 200) {
          for (const chunk of splitMessage(formatForTelegram(text))) {
            await ctx.reply(chunk, { parse_mode: 'HTML' });
          }
        }
      } catch (err) {
        logger.error({ err }, 'TTS failed, falling back to text');
        for (const chunk of splitMessage(formatForTelegram(text))) {
          await ctx.reply(chunk, { parse_mode: 'HTML' });
        }
      }
    } else {
      for (const chunk of splitMessage(formatForTelegram(text))) {
        await ctx.reply(chunk, { parse_mode: 'HTML' });
      }
    }
  } finally {
    clearInterval(typingInterval);
  }
}

// --- Extract video frames so the agent can "see" a video via multimodal input ---

function extractVideoFrames(videoPath: string, count = 3): string[] {
  const frames: string[] = [];
  try {
    const durationStr = execSync(
      `ffprobe -v error -show_entries format=duration -of csv=p=0 "${videoPath}"`,
      { encoding: 'utf8', timeout: 10000 }
    ).trim();
    const duration = parseFloat(durationStr) || 5;

    for (let i = 0; i < count; i++) {
      const timestamp = (duration * (i + 1)) / (count + 1);
      const framePath = `/tmp/frame_${Date.now()}_${i}.jpg`;
      try {
        execSync(
          `ffmpeg -y -ss ${timestamp.toFixed(2)} -i "${videoPath}" -frames:v 1 -q:v 2 "${framePath}" 2>/dev/null`,
          { timeout: 15000 }
        );
        if (existsSync(framePath) && statSync(framePath).size > 0) {
          frames.push(framePath);
        }
      } catch {
        // Skip this frame
      }
    }
  } catch (err) {
    logger.error({ err }, 'Failed to extract video frames');
  }
  return frames;
}

// Strip metadata (EXIF etc.) from a file in place. Requires `exiftool` on the host.
function stripMetadata(filePath: string): void {
  execSync(`exiftool -all= -overwrite_original "${filePath}"`, { timeout: 10000 });
}

const CLEAN_TRIGGER = /clean|metadata|exif|strip|очист|метаданн|мета|убери/i;

// --- Bot setup ---

export function createBot(): Bot {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN is not set. Copy .env.example to .env and fill it in.');
  }

  const bot = new Bot(TELEGRAM_BOT_TOKEN);

  // Log all incoming updates
  bot.use(async (ctx, next) => {
    logger.info({
      chatId: ctx.chat?.id,
      from: ctx.from?.username ?? ctx.from?.id,
      text: ctx.message?.text?.slice(0, 50),
      type: ctx.message ? 'message' : 'other',
    }, 'Incoming update');
    await next();
  });

  // /start
  bot.command('start', async (ctx) => {
    await ctx.reply('Claw is online. Send me anything and I will run it through the agent on your machine.');
  });

  // /chatid — print this chat's id (useful for locking down ALLOWED_CHAT_IDS)
  bot.command('chatid', async (ctx) => {
    await ctx.reply(`Your chat ID: <code>${ctx.chat.id}</code>`, { parse_mode: 'HTML' });
  });

  // /newchat and /forget — reset the Claude session and chat history for this chat
  const resetChat = async (ctx: Context) => {
    const cid = String(ctx.chat!.id);
    clearSession(cid);
    clearChatHistory(cid);
    await ctx.reply('Session cleared. Starting fresh.');
  };
  bot.command('newchat', resetChat);
  bot.command('forget', resetChat);

  // /voice — toggle spoken replies
  bot.command('voice', async (ctx) => {
    const chatId = String(ctx.chat.id);
    if (!voiceCapabilities().tts) {
      await ctx.reply('TTS is not configured. Set ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID in .env');
      return;
    }
    if (voiceEnabledChats.has(chatId)) {
      voiceEnabledChats.delete(chatId);
      await ctx.reply('Voice replies disabled. Text only.');
    } else {
      voiceEnabledChats.add(chatId);
      await ctx.reply('Voice replies enabled. I will speak back to you.');
    }
  });

  // /memory — inspect the memory store
  bot.command('memory', async (ctx) => {
    const chatId = String(ctx.chat.id);
    const subcmd = (ctx.message?.text ?? '').replace('/memory', '').trim();

    if (!subcmd || subcmd === 'stats') {
      const stats = getMemoryStatsForChat(chatId);
      await ctx.reply([
        `Total: ${stats.total} memories`,
        `  Permanent: ${stats.permanent}`,
        `  Semantic: ${stats.semantic}`,
        `  Episodic: ${stats.episodic}`,
        stats.topics.length > 0 ? `  Topics: ${stats.topics.join(', ')}` : '  No topics',
      ].join('\n'));
      return;
    }

    if (subcmd === 'permanent' || subcmd === 'perm') {
      const perm = getPermanentMemories(chatId, 20);
      if (perm.length === 0) { await ctx.reply('No permanent memories.'); return; }
      await ctx.reply('Permanent memories:\n' + perm.map(
        (m, i) => `${i + 1}. (${m.salience.toFixed(1)}) ${m.content.slice(0, 120)}`
      ).join('\n'));
      return;
    }

    if (subcmd === 'recent') {
      const recent = getRecentMemories(chatId, 15);
      if (recent.length === 0) { await ctx.reply('No memories stored yet.'); return; }
      await ctx.reply(recent.map(
        (m, i) => `${i + 1}. [${m.sector}] (${m.salience.toFixed(1)}) ${m.content.slice(0, 100)}`
      ).join('\n'));
      return;
    }

    await ctx.reply('Usage:\n/memory stats\n/memory permanent\n/memory recent\n/remember <text>');
  });

  // /remember — save something to permanent memory
  bot.command('remember', async (ctx) => {
    const chatId = String(ctx.chat.id);
    const text = (ctx.message?.text ?? '').replace('/remember', '').trim();
    if (!text) { await ctx.reply('Usage: /remember <what to remember>'); return; }
    rememberExplicit(chatId, text);
    await ctx.reply(`Saved to permanent memory: ${text.slice(0, 100)}`);
  });

  // /schedule — manage scheduled tasks for this chat
  bot.command('schedule', async (ctx) => {
    const chatId = String(ctx.chat.id);
    const parts = (ctx.message?.text ?? '').replace('/schedule', '').trim().split(/\s+/);
    const subcmd = parts[0];

    if (!subcmd || subcmd === 'list') {
      const mine = listTasks().filter(t => t.chat_id === chatId);
      if (mine.length === 0) { await ctx.reply('No scheduled tasks.'); return; }
      await ctx.reply(mine.map(t => {
        const next = new Date(t.next_run * 1000).toLocaleString();
        return `[${t.status}] ${t.id} — ${t.prompt.slice(0, 50)}... (next: ${next})`;
      }).join('\n'));
      return;
    }

    if (subcmd === 'delete' && parts[1]) {
      await ctx.reply(deleteTask(parts[1]) ? `Task ${parts[1]} deleted.` : `Task ${parts[1]} not found.`);
      return;
    }
    if (subcmd === 'pause' && parts[1]) {
      await ctx.reply(setTaskStatus(parts[1], 'paused') ? `Task ${parts[1]} paused.` : `Task ${parts[1]} not found.`);
      return;
    }
    if (subcmd === 'resume' && parts[1]) {
      await ctx.reply(setTaskStatus(parts[1], 'active') ? `Task ${parts[1]} resumed.` : `Task ${parts[1]} not found.`);
      return;
    }

    await ctx.reply('Usage:\n/schedule list\n/schedule delete <id>\n/schedule pause <id>\n/schedule resume <id>\n\nTo create a task, use the schedule-cli or just ask me in natural language.');
  });

  // Text messages
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) return; // handled by command handlers
    const enriched = await enrichMessageWithYouTube(text);
    await handleMessage(ctx, enriched);
  });

  // Voice messages — transcribe, then treat as text (with a "remember" shortcut)
  bot.on('message:voice', async (ctx) => {
    const chatId = String(ctx.chat.id);
    if (!isAuthorised(ctx.chat.id)) { await ctx.reply('Unauthorized.'); return; }

    if (!voiceCapabilities().stt) {
      await ctx.reply('Voice transcription is not configured. Set OPENAI_API_KEY in .env');
      return;
    }

    const file = await ctx.getFile();
    const filePath = await downloadMedia(TELEGRAM_BOT_TOKEN, file.file_id, 'voice.oga');

    try {
      const transcript = await transcribeAudio(filePath);

      // Fast path: "remember ..." saves straight to permanent memory
      const memoryMatch = transcript.match(/^(?:remember|запомни|запомнить)\s*[,:]?\s*(.+)/i);
      if (memoryMatch) {
        rememberExplicit(chatId, memoryMatch[1]);
        await ctx.reply(`Remembered: ${memoryMatch[1].slice(0, 200)}`);
        return;
      }

      await handleMessage(ctx, `[Voice transcribed]: ${transcript}`, true);
    } catch (err) {
      logger.error({ err }, 'Voice transcription failed');
      await ctx.reply('Failed to transcribe voice message.');
    }
  });

  // Photos — pass natively to the agent as an image (or strip metadata on request)
  bot.on('message:photo', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;
    const photos = ctx.message.photo;
    const largest = photos[photos.length - 1];
    const filePath = await downloadMedia(TELEGRAM_BOT_TOKEN, largest.file_id, 'photo.jpg');
    const caption = ctx.message.caption ?? '';

    if (CLEAN_TRIGGER.test(caption)) {
      try {
        stripMetadata(filePath);
        const size = statSync(filePath).size;
        await ctx.replyWithDocument(new InputFile(filePath, `clean_${Date.now()}.jpg`), {
          caption: `cleaned (${(size / 1024).toFixed(0)} KB)`,
        });
      } catch (e) {
        await ctx.reply(`Metadata strip failed: ${(e as Error).message.slice(0, 200)}`);
      }
      try { unlinkSync(filePath); } catch {}
      return;
    }

    const images: ImageAttachment[] = [{ path: filePath, mediaType: 'image/jpeg' }];
    await handleMessage(ctx, caption || 'Analyze this image.', false, images);
  });

  // Documents — images go to the agent, other files are described; supports metadata strip
  bot.on('message:document', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;
    const doc = ctx.message.document;
    const caption = ctx.message.caption ?? '';
    const fileName = doc.file_name ?? 'document';
    const mimeType = doc.mime_type ?? '';
    const isImage = mimeType.startsWith('image/') || /\.(jpg|jpeg|png|webp|heic|heif|bmp|tiff)$/i.test(fileName);

    const filePath = await downloadMedia(TELEGRAM_BOT_TOKEN, doc.file_id, fileName);

    if (CLEAN_TRIGGER.test(caption)) {
      try {
        stripMetadata(filePath);
        const size = statSync(filePath).size;
        const ext = fileName.includes('.') ? '.' + fileName.split('.').pop() : '';
        await ctx.replyWithDocument(new InputFile(filePath, `clean_${Date.now()}${ext}`), {
          caption: `cleaned (${(size / 1024).toFixed(0)} KB)`,
        });
      } catch (e) {
        await ctx.reply(`Metadata strip failed: ${(e as Error).message.slice(0, 200)}`);
      }
      try { unlinkSync(filePath); } catch {}
      return;
    }

    if (isImage) {
      const mediaType = (mimeType as ImageAttachment['mediaType']) || 'image/jpeg';
      await handleMessage(ctx, caption || 'Analyze this image.', false, [{ path: filePath, mediaType }]);
      return;
    }

    await handleMessage(ctx, buildDocumentMessage(filePath, fileName, caption));
  });

  // Video — extract frames and pass them to the agent as images
  bot.on('message:video', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;
    const video = ctx.message.video;
    const caption = ctx.message.caption ?? '';
    const filePath = await downloadMedia(TELEGRAM_BOT_TOKEN, video.file_id, video.file_name ?? 'video.mp4');

    const frames = extractVideoFrames(filePath);
    const images: ImageAttachment[] = frames.map(f => ({ path: f, mediaType: 'image/jpeg' as const }));

    const message = [
      `[Video file: ${filePath}]`,
      caption || '',
      images.length > 0
        ? `Showing you ${images.length} frames from this video. Analyze the content based on these frames.`
        : 'Please analyze this video.',
    ].filter(Boolean).join('\n');

    await handleMessage(ctx, message, false, images.length > 0 ? images : undefined);
  });

  // Video notes (round video messages) — extract frames
  bot.on('message:video_note', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;
    const videoNote = ctx.message.video_note;
    const filePath = await downloadMedia(TELEGRAM_BOT_TOKEN, videoNote.file_id, 'video_note.mp4');

    const frames = extractVideoFrames(filePath);
    const images: ImageAttachment[] = frames.map(f => ({ path: f, mediaType: 'image/jpeg' as const }));

    const message = images.length > 0
      ? `[Video circle: ${filePath}]\nThis is a Telegram video circle. Showing you ${images.length} frames. Reply based on what you see.`
      : buildVideoNoteMessage(filePath);

    await handleMessage(ctx, message, false, images.length > 0 ? images : undefined);
  });

  bot.catch((err) => {
    logger.error({ err: err.error, ctx: err.ctx?.update }, 'Bot error');
  });

  return bot;
}

// Fire-and-forget sender used by the scheduler to deliver task results.
export async function sendTelegramMessage(chatId: string, text: string): Promise<void> {
  const bot = new Bot(TELEGRAM_BOT_TOKEN);
  for (const chunk of splitMessage(formatForTelegram(text))) {
    await bot.api.sendMessage(Number(chatId), chunk, { parse_mode: 'HTML' });
  }
}
