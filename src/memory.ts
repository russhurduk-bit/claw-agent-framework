import {
  insertMemory,
  searchMemoriesFTS,
  getRecentMemories,
  getMemoriesByTopic,
  getPermanentMemories,
  getGlobalMemories,
  touchMemory,
  decayMemoriesDB,
  deduplicateCheck,
  consolidateEpisodic,
  getMemoryStats,
  updateMemory,
  deleteMemoryById,
  getChatHistory,
} from './db.js';
import { logger } from './logger.js';

// --- Patterns for detecting important content ---

const SEMANTIC_PATTERNS = [
  // Personal facts
  /\b(my|mine|i am|i'm|i have|i prefer|i like|i hate|i need|i want)\b/i,
  /\b(мой|моя|мои|моё|я |меня зовут|у меня|мне нравится|мне нужно)\b/i,
  // Explicit memory commands
  /\b(remember|always|never|don't forget|keep in mind|note that)\b/i,
  /\b(запомни|всегда|никогда|не забудь|имей в виду|учти что)\b/i,
  // Preferences and habits
  /\b(prefer|usually|normally|every day|every week|routine)\b/i,
  /\b(предпочитаю|обычно|каждый день|каждую неделю|привычка)\b/i,
  // Identity and relationships
  /\b(wife|husband|daughter|son|friend|colleague|boss|teacher|brother|sister|parent)\b/i,
  /\b(жена|муж|дочь|сын|друг|коллега|начальник|учитель|мама|папа|брат|сестра|девушка|парень)\b/i,
  // Important dates and events
  /\b(birthday|anniversary|deadline|appointment|meeting)\b/i,
  /\b(день рождения|годовщина|дедлайн|встреча|событие)\b/i,
  // Opinions and preferences
  /\b(i think|i believe|in my opinion|i always|i never)\b/i,
  /\b(я думаю|я считаю|по-моему|мне кажется|я всегда|я никогда)\b/i,
  // Plans and goals
  /\b(i plan|going to|want to|need to|should|must|will)\b/i,
  /\b(планирую|собираюсь|хочу|надо|нужно|буду|должен)\b/i,
  // Location and address
  /\b(live in|live at|address|located|moved to)\b/i,
  /\b(живу|адрес|переехал|нахожусь|город|район)\b/i,
];

const KEY_CREDENTIAL_PATTERNS = [
  // API keys, tokens, passwords, credentials
  /\b(api[_\s]?key|token|password|secret|credential|login|auth)\b/i,
  /\b(ключ|токен|пароль|логин|доступ|подключение)\b/i,
  // Connection strings and URLs
  /\b(url|host|port|endpoint|server|database|connection)\b/i,
  // Common service names worth remembering
  /\b(telegram|openai|google|github|elevenlabs)\b/i,
];

const EXPLICIT_REMEMBER = /\b(запомни|remember|always remember|don't forget|не забудь|сохрани|save this)\b/i;

// Patterns for extracting facts from assistant responses
const ASSISTANT_FACT_PATTERNS = [
  /\b(your|you have|you are|you're|you live|you said|you mentioned|you told)\b/i,
  /\b(твой|твоя|ты |тебя|тебе|у тебя|ты говорил|ты сказал|ты упоминал)\b/i,
  /\b(saved|noted|remembered|recorded|set|configured|enabled|disabled|installed|created)\b/i,
  /\b(сохранил|запомнил|записал|настроил|включил|выключил|установил|создал)\b/i,
];

// --- Entity extraction ---

interface ExtractedEntities {
  people: string[];
  dates: string[];
  locations: string[];
}

function extractEntities(text: string): ExtractedEntities {
  const entities: ExtractedEntities = { people: [], dates: [], locations: [] };

  // Names (capitalized words after relationship markers)
  const namePatterns = [
    /(?:зовут|имя|это|друг|подруга|брат|сестра|мама|папа|жена|муж|девушка|парень)\s+([А-ЯЁ][а-яё]+)/g,
    /(?:name is|called|friend|brother|sister|mom|dad|wife|husband|girlfriend|boyfriend)\s+([A-Z][a-z]+)/g,
    // Standalone capitalized names in Russian (after verbs like сказал, написал, ответил)
    /(?:сказал|написал|ответил|спросил|говорит)\s+([А-ЯЁ][а-яё]+)/g,
    // @mentions
    /@([A-Za-z0-9_]+)/g,
  ];
  for (const p of namePatterns) {
    let m;
    while ((m = p.exec(text)) !== null) {
      entities.people.push(m[1]);
    }
  }

  // Dates
  const datePatterns = [
    /(\d{1,2}[./]\d{1,2}[./]\d{2,4})/g,
    /(\d{1,2}\s+(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)(?:\s+\d{4})?)/gi,
    /(\d{1,2}\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+\d{4})?)/gi,
    /(сегодня|вчера|завтра|послезавтра|today|yesterday|tomorrow)/gi,
  ];
  for (const p of datePatterns) {
    let m;
    while ((m = p.exec(text)) !== null) {
      entities.dates.push(m[1]);
    }
  }

  // Locations (cities, countries)
  const locationPatterns = [
    /(?:в городе|город|из |живу в|переехал в|еду в)\s+([А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё]+)?)/g,
    /(?:in |from |live in |moved to |going to )\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/g,
  ];
  for (const p of locationPatterns) {
    let m;
    while ((m = p.exec(text)) !== null) {
      entities.locations.push(m[1]);
    }
  }

  return entities;
}

// --- Classification ---

type MemoryType = 'permanent' | 'semantic' | 'episodic' | 'skip';

/**
 * FOCUSED MEMORY MODE: Save only genuinely important user messages.
 * Skip transient requests, short noise, and routine commands.
 */
function classifyMessage(text: string): { type: MemoryType; salience: number; topic?: string; entities?: ExtractedEntities } {
  // Skip slash commands
  if (text.startsWith('/')) {
    return { type: 'skip', salience: 0 };
  }

  // Skip short noise (< 15 chars) — "ок", "да", "нет", "спс" etc.
  if (text.length < 15) {
    return { type: 'skip', salience: 0 };
  }

  // Voice messages are important - user took time to speak
  const isVoice = text.startsWith('[Voice transcribed]:');
  const cleanText = isVoice ? text.replace('[Voice transcribed]: ', '') : text;

  const entities = extractEntities(cleanText);
  const hasEntities = entities.people.length > 0 || entities.dates.length > 0 || entities.locations.length > 0;
  const topic = extractTopic(cleanText);

  // Explicit "remember this" - always permanent
  if (EXPLICIT_REMEMBER.test(cleanText)) {
    return { type: 'permanent', salience: 5.0, topic, entities };
  }

  // Keys and credentials - permanent
  if (KEY_CREDENTIAL_PATTERNS.some(p => p.test(cleanText))) {
    return { type: 'permanent', salience: 5.0, topic: 'credentials', entities };
  }

  // Semantic patterns (personal info, opinions, plans, preferences)
  if (SEMANTIC_PATTERNS.some(p => p.test(cleanText))) {
    return { type: 'semantic', salience: 3.0, topic, entities };
  }

  // Messages with named entities - personal facts
  if (hasEntities) {
    return { type: 'semantic', salience: 3.0, topic, entities };
  }

  // Voice messages - always semantic (user effort to record)
  if (isVoice) {
    return { type: 'semantic', salience: 2.5, topic, entities };
  }

  // Skip routine commands/instructions — they are ephemeral tasks, not memories
  // Only save if they also contain personal facts (caught above)
  const isInstruction = /\b(сделай|настрой|добавь|убери|измени|поменяй|создай|удали|запусти|останови|включи|выключи|покажи|найди|пробей|проверь|обнови|почини|исправь|напиши|отправь|скачай|загрузи|установи|разверни|помоги|расскажи|объясни|опиши|подскажи|скинь|открой|закрой|поставь|убери|верни|поправь)\b/i.test(cleanText) ||
    /\b(make|create|add|remove|delete|change|update|fix|build|deploy|install|configure|setup|start|stop|show|find|check|run|send|download|upload|help|explain|describe)\b/i.test(cleanText);
  if (isInstruction) {
    return { type: 'skip', salience: 0 };
  }

  // Longer messages (>100 chars) with a topic — likely meaningful context
  if (topic && cleanText.length > 100) {
    return { type: 'episodic', salience: 1.5, topic, entities };
  }

  // Everything else — skip. Don't pollute memory with noise.
  return { type: 'skip', salience: 0 };
}

/**
 * DISABLED: Bot responses are NOT saved to memory.
 * They create noise, echo chambers, and irrelevant context.
 * The chat_history table already preserves conversation continuity.
 */
function classifyAssistantMessage(_text: string): { type: MemoryType; salience: number; topic?: string } {
  return { type: 'skip', salience: 0 };
}

function extractTopic(text: string): string | undefined {
  const lower = text.toLowerCase();

  // Generic, domain-agnostic topic classifier. Extend with your own domains.
  const topics: Array<[RegExp, string]> = [
    [/\b(bank|budget|money|spend|expense|invoice|payment|банк|бюджет|деньги|траты|расход)\b/i, 'finance'],
    [/\b(router|vpn|wifi|network|internet|dns|роутер|сеть|интернет)\b/i, 'network'],
    [/\b(telegram|телеграм|бот|bot|channel|chat|канал|чат|сообщен)\b/i, 'telegram'],
    [/\b(youtube|video|movie|series|music|spotify|видео|ютуб|фильм|музык)\b/i, 'media'],
    [/\b(gmail|calendar|email|mail|почта|календарь|письм)\b/i, 'mail'],
    [/\b(family|wife|husband|daughter|son|mom|dad|brother|sister|семья|жена|муж|дочь|сын|родител)\b/i, 'family'],
    [/\b(work|project|task|code|program|develop|deploy|работа|проект|задач|код|программ)\b/i, 'work'],
    [/\b(health|illness|doctor|medicine|pharmacy|здоровье|болезн|врач|лечен|таблетк)\b/i, 'health'],
    [/\b(food|recipe|cook|restaurant|cafe|order|еда|рецепт|готовить|ресторан|кафе)\b/i, 'food'],
    [/\b(travel|flight|hotel|visa|trip|путешеств|поезд|самолёт|отель|виза)\b/i, 'travel'],
    [/\b(buy|order|shop|price|store|покупк|купить|заказ|магазин|цена)\b/i, 'shopping'],
    [/\b(sport|workout|gym|fitness|run|спорт|тренировк|фитнес|бег)\b/i, 'sports'],
    [/\b(car|drive|fuel|parking|авто|машин|водить|бензин|парковк)\b/i, 'auto'],
    [/\b(workflow|automation|pipeline|integration|автоматизац|воркфлоу)\b/i, 'automation'],
    [/\b(server|vps|docker|nginx|systemd|ssh|firewall|сервер)\b/i, 'server'],
    [/\b(memory|session|context|remember|память|сессия|контекст|запомни)\b/i, 'memory'],
    [/\b(plan|goal|strategy|roadmap|план|цель|стратег)\b/i, 'strategy'],
    [/\b(photo|image|picture|screenshot|фото|картинк|скриншот|снимок)\b/i, 'media'],
  ];

  for (const [pattern, topic] of topics) {
    if (pattern.test(lower)) return topic;
  }

  return undefined;
}

// --- Core functions ---

/**
 * Build memory context to prepend to a user message.
 * FOCUSED MODE: only permanent memories + targeted FTS. No noise.
 */
export function buildMemoryContext(
  chatId: string,
  userMessage: string,
  options: { crossChat?: boolean } = {}
): string {
  // crossChat defaults to true: permanent memories are shared across a user's chats.
  // Pass crossChat=false for isolated chats (e.g. a separate/guest bot) so they never
  // see another chat's permanent facts or credentials that match the classifier.
  const { crossChat = true } = options;
  const seen = new Set<number>();
  const results: Array<{ id: number; content: string; sector: string; salience: number }> = [];

  // 1. Permanent memories (user-explicit, credentials) — these are always relevant
  const permanent = getPermanentMemories(chatId, 50);
  for (const r of permanent) {
    if (!seen.has(r.id)) {
      seen.add(r.id);
      results.push(r);
    }
  }

  // 2. Cross-chat: ONLY permanent memories (no semantic noise from other chats).
  //    Skipped entirely for isolated chats (crossChat=false).
  if (crossChat) {
    const globalPerm = getGlobalMemories(chatId, 10);
    for (const r of globalPerm) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        results.push({ ...r, content: `[global] ${r.content}` });
      }
    }
  }

  // 3. Targeted FTS — only phrase-based queries, no individual word OR noise
  const sanitized = userMessage.replace(/[^\p{L}\p{N}\s]/gu, '').trim();
  if (sanitized.length > 5) {
    const words = sanitized.split(/\s+/).filter(w => w.length > 2);
    if (words.length >= 2) {
      const queries = [
        // Exact phrase (first 5 words)
        `"${words.slice(0, 5).join(' ')}"`,
        // Adjacent word pairs only (no single words)
        ...words.slice(0, 4).map((w, i) => i < words.length - 1 ? `"${w} ${words[i + 1]}"` : null),
      ].filter(Boolean) as string[];

      for (const ftsQuery of queries) {
        try {
          const ftsResults = searchMemoriesFTS(ftsQuery, 5, chatId);
          for (const r of ftsResults) {
            if (!seen.has(r.id)) {
              seen.add(r.id);
              results.push(r);
            }
          }
        } catch {
          // FTS query can fail on certain inputs
        }
      }
    }
  }

  // 4. Topic-based memories — only if topic detected, limited
  const topic = extractTopic(userMessage);
  if (topic) {
    const topicResults = getMemoriesByTopic(chatId, topic, 5);
    for (const r of topicResults) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        results.push(r);
      }
    }
  }

  // 5. Entity-based recall (people, locations mentioned by name)
  const entities = extractEntities(userMessage);
  const entityTerms = [...entities.people, ...entities.locations].filter(e => e.length > 2);
  for (const term of entityTerms.slice(0, 3)) {
    try {
      const entityResults = searchMemoriesFTS(`"${term}"`, 5, chatId);
      for (const r of entityResults) {
        if (!seen.has(r.id)) {
          seen.add(r.id);
          results.push(r);
        }
      }
    } catch {}
  }

  // NO "recent memories" — they add noise unrelated to current message.
  // Chat history below provides conversation continuity instead.

  // Build chat history section (last 8 exchanges = 16 messages)
  const history = getChatHistory(chatId, 8);
  let historyBlock = '';
  if (history.length > 0) {
    const historyLines = history.map(h => {
      const prefix = h.role === 'user' ? 'User' : 'You';
      // Truncate long messages
      const text = h.content.length > 300 ? h.content.slice(0, 300) + '...' : h.content;
      return `${prefix}: ${text}`;
    });
    historyBlock = `[CONVERSATION HISTORY — last ${Math.ceil(history.length / 2)} exchanges]\n${historyLines.join('\n')}`;
  }

  if (results.length === 0 && !historyBlock) return '';
  if (results.length === 0) return historyBlock;

  // Touch accessed memories (update accessed_at only, no salience inflation)
  for (const r of results) {
    touchMemory(r.id);
  }

  // Sort: permanent first, then by salience
  results.sort((a, b) => {
    if (a.sector === 'permanent' && b.sector !== 'permanent') return -1;
    if (b.sector === 'permanent' && a.sector !== 'permanent') return 1;
    return b.salience - a.salience;
  });

  // Cap at 15 items — quality over quantity
  const capped = results.slice(0, 15);

  // Format with sector labels
  const lines = capped.map(r => {
    const label = r.sector === 'permanent' ? 'PERM' : r.sector === 'semantic' ? 'FACT' : 'HIST';
    return `- [${label}] ${r.content}`;
  });

  const memoryBlock = `[MEMORY — reference only, respond to CURRENT MESSAGE below, not memory]\n${lines.join('\n')}`;

  return historyBlock
    ? `${historyBlock}\n\n${memoryBlock}`
    : memoryBlock;
}

/**
 * Save a conversation turn as memory.
 * FOCUSED MODE: Only save user messages that contain genuine personal facts/preferences.
 * Bot responses are NOT saved — chat_history handles conversation continuity.
 */
export function saveConversationTurn(
  chatId: string,
  userMsg: string,
  _assistantMsg: string
): void {
  // Only save user message if classified as important
  const userClass = classifyMessage(userMsg);
  if (userClass.type === 'skip') return;

  const isDupe = deduplicateCheck(chatId, userMsg, 0.85);
  if (isDupe) return;

  let content = userMsg;
  if (userClass.entities) {
    const tags: string[] = [];
    if (userClass.entities.people.length > 0) tags.push(`[people: ${userClass.entities.people.join(', ')}]`);
    if (userClass.entities.dates.length > 0) tags.push(`[dates: ${userClass.entities.dates.join(', ')}]`);
    if (userClass.entities.locations.length > 0) tags.push(`[places: ${userClass.entities.locations.join(', ')}]`);
    if (tags.length > 0) content = `${content} ${tags.join(' ')}`;
  }
  insertMemory(chatId, content, userClass.type, userClass.topic, userClass.salience);
}

/**
 * Extract more content from long assistant responses.
 */
function extractFullResponse(text: string): string {
  // Remove code blocks but note their presence
  let hasCode = false;
  const cleaned = text.replace(/```[\s\S]*?```/g, () => { hasCode = true; return '[code block]'; });

  // Split into sentences
  const sentences = cleaned.split(/[.!?\n]+/).map(s => s.trim()).filter(s => s.length > 10);

  // Skip filler
  const skipPatterns = [
    /^(ok|okay|sure|got it|done|ready|hello|hi|hey|привет|хорошо|ок|окей|готово|понял|ладно|давай|let me|сейчас|вот)/i,
  ];

  const meaningful = sentences.filter(s => !skipPatterns.some(p => p.test(s)));
  if (meaningful.length === 0) return '';

  // Take up to 5 sentences, 1500 chars
  let result = meaningful.slice(0, 5).join('. ').substring(0, 1500);
  if (hasCode) result += ' [contains code]';
  return result;
}

/**
 * Extract key sentences from assistant response.
 */
function extractKeySentence(text: string): string {
  const cleaned = text.replace(/```[\s\S]*?```/g, '[code]').replace(/`[^`]+`/g, '[code]');

  const sentences = cleaned.split(/[.!?\n]+/).map(s => s.trim()).filter(s => s.length > 10);

  const skipPatterns = [
    /^(ok|okay|sure|got it|done|ready|hello|hi|hey|привет|хорошо|ок|окей|готово|понял|ладно)/i,
    /^(here|вот|давай|let me|сейчас)/i,
  ];

  const meaningful = sentences.filter(s => !skipPatterns.some(p => p.test(s)));
  if (meaningful.length === 0) return sentences[0] || '';

  // Return first 4 meaningful sentences, up to 1000 chars
  return meaningful.slice(0, 4).join('. ').substring(0, 1000);
}

/**
 * Explicitly save something to permanent memory (user command).
 */
export function rememberExplicit(
  chatId: string,
  content: string,
  topic?: string
): void {
  insertMemory(chatId, content, 'permanent', topic || extractTopic(content), 5.0);
}

/**
 * MAXIMUM MODE: No decay sweep. Memories are never deleted automatically.
 * Only consolidate very old episodic into summaries to save space.
 */
export function runDecaySweep(): void {
  // NO decay — keep everything at original salience
  // Only consolidate episodic older than 30 days (not 7)
  const consolidated = consolidateEpisodic();

  if (consolidated > 0) {
    logger.info({ consolidated }, 'Memory consolidation completed (no decay)');
  }
}

/**
 * Get memory statistics for a chat.
 */
export function getMemoryStatsForChat(chatId: string) {
  return getMemoryStats(chatId);
}
