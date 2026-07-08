import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  initDatabase,
  getSession,
  setSession,
  clearSession,
  insertMemory,
  getRecentMemories,
  searchMemoriesFTS,
  decayMemoriesDB,
  createTask,
  getDueTasks,
  listTasks,
  deleteTask,
  setTaskStatus,
} from './db.js';
import { STORE_DIR } from './config.js';

const dbPath = resolve(STORE_DIR, 'claw.db');

describe('Database', () => {
  beforeEach(() => {
    // Remove existing DB to start fresh
    try { unlinkSync(dbPath); } catch { /* noop */ }
    try { unlinkSync(dbPath + '-wal'); } catch { /* noop */ }
    try { unlinkSync(dbPath + '-shm'); } catch { /* noop */ }
    initDatabase();
  });

  describe('sessions', () => {
    it('should set and get a session', () => {
      setSession('123', 'session-abc');
      expect(getSession('123')).toBe('session-abc');
    });

    it('should return undefined for missing session', () => {
      expect(getSession('nonexistent')).toBeUndefined();
    });

    it('should clear a session', () => {
      setSession('123', 'session-abc');
      clearSession('123');
      expect(getSession('123')).toBeUndefined();
    });

    it('should update existing session', () => {
      setSession('123', 'session-1');
      setSession('123', 'session-2');
      expect(getSession('123')).toBe('session-2');
    });
  });

  describe('memories', () => {
    it('should insert and retrieve memories', () => {
      insertMemory('chat1', 'I like TypeScript', 'semantic');
      insertMemory('chat1', 'Had a good day', 'episodic');
      const memories = getRecentMemories('chat1', 10);
      expect(memories).toHaveLength(2);
    });

    it('should search via FTS', () => {
      insertMemory('chat1', 'My favorite language is TypeScript', 'semantic');
      insertMemory('chat1', 'The weather is nice today', 'episodic');
      const results = searchMemoriesFTS('TypeScript*');
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].content).toContain('TypeScript');
    });

    it('should retain memories (retention mode: no decay, no deletion)', async () => {
      insertMemory('chat1', 'Old memory', 'episodic', undefined, 0.15);
      // Manually backdate the created_at
      const { getDb } = await import('./db.js');
      const twoDaysAgo = Math.floor(Date.now() / 1000) - 200000;
      getDb().prepare('UPDATE memories SET created_at = ?').run(twoDaysAgo);

      // Retention mode keeps every memory at its original salience.
      const { decayed, deleted } = decayMemoriesDB();
      expect(decayed).toBe(0);
      expect(deleted).toBe(0);
      expect(getRecentMemories('chat1', 10)).toHaveLength(1);
    });
  });

  describe('scheduled tasks', () => {
    it('should create and list tasks', () => {
      createTask('t1', 'chat1', 'Do something', '0 9 * * *', Math.floor(Date.now() / 1000) + 3600);
      const tasks = listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe('t1');
    });

    it('should find due tasks', () => {
      const pastTime = Math.floor(Date.now() / 1000) - 60;
      createTask('t2', 'chat1', 'Past task', '0 9 * * *', pastTime);
      const due = getDueTasks();
      expect(due).toHaveLength(1);
    });

    it('should delete tasks', () => {
      createTask('t3', 'chat1', 'Delete me', '0 9 * * *', 9999999999);
      expect(deleteTask('t3')).toBe(true);
      expect(listTasks()).toHaveLength(0);
    });

    it('should pause and resume tasks', () => {
      createTask('t4', 'chat1', 'Pause me', '0 9 * * *', 9999999999);
      setTaskStatus('t4', 'paused');
      expect(listTasks()[0].status).toBe('paused');
      setTaskStatus('t4', 'active');
      expect(listTasks()[0].status).toBe('active');
    });
  });
});
