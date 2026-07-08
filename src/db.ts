import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { STORE_DIR } from './config.js';
import { logger } from './logger.js';

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

export function initDatabase(): void {
  mkdirSync(STORE_DIR, { recursive: true });
  const dbPath = resolve(STORE_DIR, 'claw.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  // Sessions table (always)
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      chat_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // Full memory tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      topic_key TEXT,
      content TEXT NOT NULL,
      sector TEXT NOT NULL CHECK(sector IN ('semantic','episodic','permanent')),
      salience REAL NOT NULL DEFAULT 1.0,
      created_at INTEGER NOT NULL,
      accessed_at INTEGER NOT NULL
    )
  `);

  // Migration: add 'permanent' to allowed sectors
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS _migrations (key TEXT PRIMARY KEY)`);
    const migrated = db.prepare("SELECT key FROM _migrations WHERE key = 'add_permanent_sector'").get();
    if (!migrated) {
      // SQLite doesn't support ALTER CHECK. Recreate table with new constraint.
      const hasData = db.prepare("SELECT COUNT(*) as cnt FROM memories").get() as any;
      if (hasData?.cnt > 0) {
        // Drop FTS triggers first
        db.exec(`DROP TRIGGER IF EXISTS memories_ai`);
        db.exec(`DROP TRIGGER IF EXISTS memories_ad`);
        db.exec(`DROP TRIGGER IF EXISTS memories_au`);
        // Drop FTS table
        db.exec(`DROP TABLE IF EXISTS memories_fts`);
        // Recreate main table
        db.exec(`ALTER TABLE memories RENAME TO memories_old`);
        db.exec(`
          CREATE TABLE memories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id TEXT NOT NULL,
            topic_key TEXT,
            content TEXT NOT NULL,
            sector TEXT NOT NULL CHECK(sector IN ('semantic','episodic','permanent')),
            salience REAL NOT NULL DEFAULT 1.0,
            created_at INTEGER NOT NULL,
            accessed_at INTEGER NOT NULL
          )
        `);
        db.exec(`INSERT INTO memories SELECT * FROM memories_old`);
        db.exec(`DROP TABLE memories_old`);
      }
      db.prepare("INSERT INTO _migrations (key) VALUES ('add_permanent_sector')").run();
      logger.info('Migration: added permanent sector to memories table');
    }
  } catch (err) {
    logger.warn({ err }, 'Migration warning (may be fine on fresh install)');
  }

  // Index for topic-based queries
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_topic ON memories(chat_id, topic_key)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_sector ON memories(chat_id, sector)`);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content,
      content='memories',
      content_rowid='id'
    )
  `);

  // FTS sync triggers for external content table
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.id, old.content);
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.id, old.content);
      INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
    END
  `);

  // Chat history table — stores raw messages for conversation continuity
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user','assistant')),
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_history_chat ON chat_history(chat_id, created_at DESC)`);

  // Scheduler tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule TEXT NOT NULL,
      next_run INTEGER NOT NULL,
      last_run INTEGER,
      last_result TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused')),
      created_at INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_status_next ON scheduled_tasks(status, next_run)
  `);

  logger.info('Database initialized');
}

// --- Session CRUD ---

const SESSION_TTL_SECONDS = 6 * 3600; // 6 hours - after this, start fresh session with memory

export function getSession(chatId: string): string | undefined {
  const row = getDb()
    .prepare('SELECT session_id, updated_at FROM sessions WHERE chat_id = ?')
    .get(chatId) as { session_id: string; updated_at: number } | undefined;
  if (!row) return undefined;

  // Check TTL - if session is too old, start fresh
  const age = Math.floor(Date.now() / 1000) - row.updated_at;
  if (age > SESSION_TTL_SECONDS) {
    return undefined; // Will create new session, memory context carries over
  }
  return row.session_id;
}

export function setSession(chatId: string, sessionId: string): void {
  getDb()
    .prepare(
      'INSERT INTO sessions (chat_id, session_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at'
    )
    .run(chatId, sessionId, Math.floor(Date.now() / 1000));
}

export function clearSession(chatId: string): void {
  getDb().prepare('DELETE FROM sessions WHERE chat_id = ?').run(chatId);
}

// --- Memory CRUD ---

export function insertMemory(
  chatId: string,
  content: string,
  sector: 'semantic' | 'episodic' | 'permanent',
  topicKey?: string,
  salience = 1.0
): void {
  const now = Math.floor(Date.now() / 1000);
  getDb()
    .prepare(
      'INSERT INTO memories (chat_id, topic_key, content, sector, salience, created_at, accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(chatId, topicKey ?? null, content, sector, salience, now, now);
}

export function searchMemoriesFTS(query: string, limit = 3, chatId?: string): Array<{
  id: number;
  chat_id: string;
  content: string;
  sector: string;
  salience: number;
}> {
  const sql = chatId
    ? `SELECT m.id, m.chat_id, m.content, m.sector, m.salience
       FROM memories_fts f
       JOIN memories m ON m.id = f.rowid
       WHERE memories_fts MATCH ? AND m.chat_id = ?
       ORDER BY m.salience DESC, rank
       LIMIT ?`
    : `SELECT m.id, m.chat_id, m.content, m.sector, m.salience
       FROM memories_fts f
       JOIN memories m ON m.id = f.rowid
       WHERE memories_fts MATCH ?
       ORDER BY m.salience DESC, rank
       LIMIT ?`;
  const params = chatId ? [query, chatId, limit] : [query, limit];
  return getDb().prepare(sql).all(...params) as Array<{
    id: number;
    chat_id: string;
    content: string;
    sector: string;
    salience: number;
  }>;
}

export function getRecentMemories(chatId: string, limit = 5): Array<{
  id: number;
  content: string;
  sector: string;
  salience: number;
}> {
  return getDb()
    .prepare(
      `SELECT id, content, sector, salience
       FROM memories
       WHERE chat_id = ?
       ORDER BY accessed_at DESC
       LIMIT ?`
    )
    .all(chatId, limit) as Array<{
    id: number;
    content: string;
    sector: string;
    salience: number;
  }>;
}

export function touchMemory(id: number): void {
  const now = Math.floor(Date.now() / 1000);
  // Only update accessed_at — do NOT inflate salience on access
  getDb()
    .prepare('UPDATE memories SET accessed_at = ? WHERE id = ?')
    .run(now, id);
}

export function decayMemoriesDB(): { decayed: number; deleted: number } {
  // MAXIMUM MEMORY MODE: NO decay, NO deletion
  // All memories keep their original salience forever
  return { decayed: 0, deleted: 0 };
}

// --- New memory functions ---

export function getPermanentMemories(chatId: string, limit = 20): Array<{
  id: number;
  content: string;
  sector: string;
  salience: number;
}> {
  return getDb()
    .prepare(
      `SELECT id, content, sector, salience
       FROM memories
       WHERE chat_id = ? AND sector = 'permanent'
       ORDER BY salience DESC, accessed_at DESC
       LIMIT ?`
    )
    .all(chatId, limit) as any[];
}

/**
 * Get permanent memories from OTHER chats (cross-chat sharing).
 * Only permanent sector — semantic from other chats is usually noise.
 */
export function getGlobalMemories(excludeChatId: string, limit = 10): Array<{
  id: number;
  content: string;
  sector: string;
  salience: number;
}> {
  return getDb()
    .prepare(
      `SELECT id, content, sector, salience
       FROM memories
       WHERE chat_id != ? AND sector = 'permanent'
       ORDER BY salience DESC, accessed_at DESC
       LIMIT ?`
    )
    .all(excludeChatId, limit) as any[];
}

export function getMemoriesByTopic(chatId: string, topic: string, limit = 5): Array<{
  id: number;
  content: string;
  sector: string;
  salience: number;
}> {
  return getDb()
    .prepare(
      `SELECT id, content, sector, salience
       FROM memories
       WHERE chat_id = ? AND topic_key = ?
       ORDER BY salience DESC, accessed_at DESC
       LIMIT ?`
    )
    .all(chatId, topic, limit) as any[];
}

/**
 * Check if a similar memory already exists using both substring and word-overlap (Jaccard) similarity.
 * Returns true if a duplicate is found.
 */
export function deduplicateCheck(chatId: string, content: string, threshold = 0.8): boolean {
  const trimmed = content.trim();
  if (trimmed.length < 20) return false;

  // 1. Quick check: exact substring match on first 100 chars
  const signature = trimmed.substring(0, 100);
  const exactMatch = getDb()
    .prepare(
      `SELECT id FROM memories
       WHERE chat_id = ? AND content LIKE ?
       LIMIT 1`
    )
    .get(chatId, `%${signature.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`) as any;

  if (exactMatch) return true;

  // 2. Word-overlap (Jaccard) check against recent memories
  const words = new Set(trimmed.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  if (words.size < 3) return false;

  const recent = getDb()
    .prepare(
      `SELECT id, content FROM memories
       WHERE chat_id = ? AND length(content) BETWEEN ? AND ?
       ORDER BY created_at DESC
       LIMIT 50`
    )
    .all(chatId, Math.floor(trimmed.length * 0.5), Math.floor(trimmed.length * 2)) as Array<{ id: number; content: string }>;

  for (const mem of recent) {
    const memWords = new Set(mem.content.toLowerCase().split(/\s+/).filter(w => w.length > 3));
    let intersection = 0;
    for (const w of words) {
      if (memWords.has(w)) intersection++;
    }
    const union = words.size + memWords.size - intersection;
    const jaccard = union > 0 ? intersection / union : 0;
    if (jaccard >= threshold) return true;
  }

  return false;
}

/**
 * Consolidate old episodic memories: group by day and create summary entries.
 * Returns number of consolidated groups.
 */
export function consolidateEpisodic(): number {
  const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 86400;

  // Find episodic memories older than 7 days, grouped by chat_id and day
  const oldEpisodic = getDb()
    .prepare(
      `SELECT id, chat_id, content, created_at,
              date(created_at, 'unixepoch') as day
       FROM memories
       WHERE sector = 'episodic' AND created_at < ? AND salience < 1.0
       ORDER BY chat_id, created_at`
    )
    .all(thirtyDaysAgo) as Array<{
    id: number;
    chat_id: string;
    content: string;
    created_at: number;
    day: string;
  }>;

  if (oldEpisodic.length < 5) return 0;

  // Group by chat_id + day
  const groups = new Map<string, typeof oldEpisodic>();
  for (const m of oldEpisodic) {
    const key = `${m.chat_id}:${m.day}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(m);
  }

  let consolidated = 0;
  for (const [key, memories] of groups) {
    if (memories.length < 3) continue; // Not worth consolidating

    const chatId = memories[0].chat_id;
    const day = memories[0].day;

    // Create a summary by keeping first 200 chars of each, joined
    const summary = memories
      .map(m => m.content.substring(0, 150))
      .join(' | ')
      .substring(0, 800);

    // Insert consolidated summary
    const now = Math.floor(Date.now() / 1000);
    getDb()
      .prepare(
        `INSERT INTO memories (chat_id, topic_key, content, sector, salience, created_at, accessed_at)
         VALUES (?, ?, ?, 'semantic', 2.0, ?, ?)`
      )
      .run(chatId, `summary:${day}`, `[Summary ${day}] ${summary}`, now, now);

    // Delete the original episodic entries
    const ids = memories.map(m => m.id);
    getDb()
      .prepare(`DELETE FROM memories WHERE id IN (${ids.map(() => '?').join(',')})`)
      .run(...ids);

    consolidated++;
  }

  return consolidated;
}

export function getMemoryStats(chatId: string): {
  total: number;
  permanent: number;
  semantic: number;
  episodic: number;
  topics: string[];
} {
  const counts = getDb()
    .prepare(
      `SELECT sector, COUNT(*) as cnt FROM memories WHERE chat_id = ? GROUP BY sector`
    )
    .all(chatId) as Array<{ sector: string; cnt: number }>;

  const topics = getDb()
    .prepare(
      `SELECT DISTINCT topic_key FROM memories WHERE chat_id = ? AND topic_key IS NOT NULL`
    )
    .all(chatId) as Array<{ topic_key: string }>;

  const result = { total: 0, permanent: 0, semantic: 0, episodic: 0, topics: topics.map(t => t.topic_key) };
  for (const c of counts) {
    result.total += c.cnt;
    if (c.sector === 'permanent') result.permanent = c.cnt;
    else if (c.sector === 'semantic') result.semantic = c.cnt;
    else if (c.sector === 'episodic') result.episodic = c.cnt;
  }
  return result;
}

export function updateMemory(id: number, content: string): void {
  getDb()
    .prepare('UPDATE memories SET content = ?, accessed_at = ? WHERE id = ?')
    .run(content, Math.floor(Date.now() / 1000), id);
}

export function deleteMemoryById(id: number): boolean {
  const result = getDb()
    .prepare('DELETE FROM memories WHERE id = ?')
    .run(id);
  return result.changes > 0;
}

// --- Scheduler CRUD ---

export function createTask(
  id: string,
  chatId: string,
  prompt: string,
  schedule: string,
  nextRun: number
): void {
  // Duplicate guard: reject if a task with very similar prompt already exists for this chat
  const existing = getDb()
    .prepare(
      `SELECT id, prompt FROM scheduled_tasks WHERE chat_id = ? AND status = 'active'`
    )
    .all(chatId) as Array<{ id: string; prompt: string }>;

  const normalise = (s: string) =>
    s.toLowerCase().replace(/[^а-яёa-z0-9]/g, '').trim();
  const newNorm = normalise(prompt);

  for (const t of existing) {
    const existNorm = normalise(t.prompt);
    if (
      existNorm === newNorm ||
      existNorm.includes(newNorm) ||
      newNorm.includes(existNorm)
    ) {
      throw new Error(
        `Duplicate task blocked: similar task already exists (${t.id}: "${t.prompt.slice(0, 60)}")`
      );
    }
  }

  const now = Math.floor(Date.now() / 1000);
  getDb()
    .prepare(
      'INSERT INTO scheduled_tasks (id, chat_id, prompt, schedule, next_run, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(id, chatId, prompt, schedule, nextRun, 'active', now);
}

export function getDueTasks(): Array<{
  id: string;
  chat_id: string;
  prompt: string;
  schedule: string;
}> {
  const now = Math.floor(Date.now() / 1000);
  return getDb()
    .prepare(
      `SELECT id, chat_id, prompt, schedule
       FROM scheduled_tasks
       WHERE status = 'active' AND next_run <= ?`
    )
    .all(now) as Array<{
    id: string;
    chat_id: string;
    prompt: string;
    schedule: string;
  }>;
}

export function updateTaskAfterRun(
  id: string,
  nextRun: number,
  lastResult: string
): void {
  const now = Math.floor(Date.now() / 1000);
  getDb()
    .prepare(
      'UPDATE scheduled_tasks SET last_run = ?, next_run = ?, last_result = ? WHERE id = ?'
    )
    .run(now, nextRun, lastResult, id);
}

export function listTasks(): Array<{
  id: string;
  chat_id: string;
  prompt: string;
  schedule: string;
  next_run: number;
  last_run: number | null;
  status: string;
}> {
  return getDb()
    .prepare('SELECT id, chat_id, prompt, schedule, next_run, last_run, status FROM scheduled_tasks')
    .all() as Array<{
    id: string;
    chat_id: string;
    prompt: string;
    schedule: string;
    next_run: number;
    last_run: number | null;
    status: string;
  }>;
}

export function deleteTask(id: string): boolean {
  const result = getDb()
    .prepare('DELETE FROM scheduled_tasks WHERE id = ?')
    .run(id);
  return result.changes > 0;
}

export function setTaskStatus(id: string, status: 'active' | 'paused'): boolean {
  const result = getDb()
    .prepare('UPDATE scheduled_tasks SET status = ? WHERE id = ?')
    .run(status, id);
  return result.changes > 0;
}

// --- Chat History ---

const CHAT_HISTORY_LIMIT = 10;

export function saveChatMessage(
  chatId: string,
  role: 'user' | 'assistant',
  content: string
): void {
  const now = Math.floor(Date.now() / 1000);
  const db = getDb();
  db.prepare(
    'INSERT INTO chat_history (chat_id, role, content, created_at) VALUES (?, ?, ?, ?)'
  ).run(chatId, role, content, now);

  // Trim: keep only last CHAT_HISTORY_LIMIT * 2 rows (20 pairs = 40 rows) per chat.
  // Order by id (monotonic) not created_at (1s granularity) so same-second rows aren't dropped wrongly.
  db.prepare(
    `DELETE FROM chat_history WHERE chat_id = ? AND id NOT IN (
       SELECT id FROM chat_history WHERE chat_id = ? ORDER BY id DESC LIMIT ?
     )`
  ).run(chatId, chatId, CHAT_HISTORY_LIMIT * 2);
}

export function getChatHistory(chatId: string, limit = CHAT_HISTORY_LIMIT): Array<{
  role: string;
  content: string;
  created_at: number;
}> {
  // Get last N*2 rows (N pairs), ordered oldest first.
  // Order by id (insert order) not created_at — created_at is seconds, so a user+assistant
  // pair saved in the same second could otherwise be returned in the wrong order.
  return getDb()
    .prepare(
      `SELECT role, content, created_at FROM (
         SELECT id, role, content, created_at FROM chat_history
         WHERE chat_id = ?
         ORDER BY id DESC
         LIMIT ?
       ) sub ORDER BY id ASC`
    )
    .all(chatId, limit * 2) as Array<{
    role: string;
    content: string;
    created_at: number;
  }>;
}

export function clearChatHistory(chatId: string): void {
  getDb().prepare('DELETE FROM chat_history WHERE chat_id = ?').run(chatId);
}
