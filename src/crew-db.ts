/**
 * Crew DB — SQLite storage for multi-agent system
 *
 * Tables: projects, tasks, crew_messages, crew_log
 */

import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { STORE_DIR } from './config.js';
import { logger } from './logger.js';
import type { Project, Task, CrewMessage, ProjectStatus, TaskStatus, MessageType } from './crew.js';

let db: Database.Database;

export function initCrewDb(): Database.Database {
  mkdirSync(STORE_DIR, { recursive: true });
  const dbPath = resolve(STORE_DIR, 'crew.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_name TEXT NOT NULL,
      client_contact TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      requirements TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'new',
      current_agent TEXT NOT NULL DEFAULT 'orchestrator',
      budget TEXT DEFAULT '',
      deadline TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      assigned_to TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      result TEXT DEFAULT '',
      attempt INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT DEFAULT NULL
    );

    CREATE TABLE IF NOT EXISTS crew_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      processed INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS crew_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER,
      agent TEXT NOT NULL,
      action TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  logger.info('Crew DB initialized');
  return db;
}

export function getCrewDb(): Database.Database {
  if (!db) initCrewDb();
  return db;
}

// ==================== PROJECTS ====================

export function createProject(p: Omit<Project, 'id' | 'createdAt' | 'updatedAt'>): number {
  const stmt = getCrewDb().prepare(`
    INSERT INTO projects (client_name, client_contact, title, description, requirements, status, current_agent, budget, deadline)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    p.clientName, p.clientContact, p.title, p.description,
    p.requirements, p.status || 'new', p.currentAgent || 'orchestrator',
    p.budget || '', p.deadline || ''
  );
  return result.lastInsertRowid as number;
}

export function getProject(id: number): Project | null {
  const row = getCrewDb().prepare('SELECT * FROM projects WHERE id = ?').get(id) as any;
  if (!row) return null;
  return {
    id: row.id,
    clientName: row.client_name,
    clientContact: row.client_contact,
    title: row.title,
    description: row.description,
    requirements: row.requirements,
    status: row.status as ProjectStatus,
    currentAgent: row.current_agent,
    budget: row.budget,
    deadline: row.deadline,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function updateProjectStatus(id: number, status: ProjectStatus, currentAgent: string): void {
  getCrewDb().prepare(`
    UPDATE projects SET status = ?, current_agent = ?, updated_at = datetime('now') WHERE id = ?
  `).run(status, currentAgent, id);
}

export function updateProjectRequirements(id: number, requirements: string): void {
  getCrewDb().prepare(`
    UPDATE projects SET requirements = ?, updated_at = datetime('now') WHERE id = ?
  `).run(requirements, id);
}

export function listProjects(status?: ProjectStatus): Project[] {
  const query = status
    ? 'SELECT * FROM projects WHERE status = ? ORDER BY updated_at DESC'
    : 'SELECT * FROM projects WHERE status != \'done\' AND status != \'delivered\' ORDER BY updated_at DESC';
  const rows = (status
    ? getCrewDb().prepare(query).all(status)
    : getCrewDb().prepare(query).all()) as any[];
  return rows.map(row => ({
    id: row.id,
    clientName: row.client_name,
    clientContact: row.client_contact,
    title: row.title,
    description: row.description,
    requirements: row.requirements,
    status: row.status as ProjectStatus,
    currentAgent: row.current_agent,
    budget: row.budget,
    deadline: row.deadline,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

// ==================== TASKS ====================

export function createTask(t: Omit<Task, 'id' | 'createdAt' | 'completedAt'>): number {
  const stmt = getCrewDb().prepare(`
    INSERT INTO tasks (project_id, assigned_to, title, description, status, attempt)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(t.projectId, t.assignedTo, t.title, t.description, t.status || 'pending', t.attempt || 1);
  return result.lastInsertRowid as number;
}

export function getTask(id: number): Task | null {
  const row = getCrewDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id) as any;
  if (!row) return null;
  return {
    id: row.id, projectId: row.project_id, assignedTo: row.assigned_to,
    title: row.title, description: row.description, status: row.status as TaskStatus,
    result: row.result, attempt: row.attempt, createdAt: row.created_at, completedAt: row.completed_at,
  };
}

export function updateTaskStatus(id: number, status: TaskStatus, result?: string): void {
  const completedAt = (status === 'done' || status === 'failed') ? "datetime('now')" : 'NULL';
  getCrewDb().prepare(`
    UPDATE tasks SET status = ?, result = COALESCE(?, result), completed_at = ${completedAt} WHERE id = ?
  `).run(status, result || null, id);
}

export function getProjectTasks(projectId: number): Task[] {
  const rows = getCrewDb().prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as any[];
  return rows.map(row => ({
    id: row.id, projectId: row.project_id, assignedTo: row.assigned_to,
    title: row.title, description: row.description, status: row.status as TaskStatus,
    result: row.result, attempt: row.attempt, createdAt: row.created_at, completedAt: row.completed_at,
  }));
}

// ==================== MESSAGES ====================

export function sendCrewMessage(msg: Omit<CrewMessage, 'id' | 'createdAt' | 'processed'>): number {
  const stmt = getCrewDb().prepare(`
    INSERT INTO crew_messages (project_id, from_agent, to_agent, type, content, metadata)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(msg.projectId, msg.fromAgent, msg.toAgent, msg.type, msg.content, msg.metadata || '{}');
  return result.lastInsertRowid as number;
}

export function getPendingMessages(toAgent: string): CrewMessage[] {
  const rows = getCrewDb().prepare(`
    SELECT * FROM crew_messages WHERE to_agent = ? AND processed = 0 ORDER BY created_at ASC
  `).all(toAgent) as any[];
  return rows.map(row => ({
    id: row.id, projectId: row.project_id, fromAgent: row.from_agent, toAgent: row.to_agent,
    type: row.type as MessageType, content: row.content, metadata: row.metadata,
    createdAt: row.created_at, processed: !!row.processed,
  }));
}

export function markMessageProcessed(id: number): void {
  getCrewDb().prepare('UPDATE crew_messages SET processed = 1 WHERE id = ?').run(id);
}

export function getProjectMessages(projectId: number, limit = 20): CrewMessage[] {
  const rows = getCrewDb().prepare(`
    SELECT * FROM crew_messages WHERE project_id = ? ORDER BY created_at DESC LIMIT ?
  `).all(projectId, limit) as any[];
  return rows.map(row => ({
    id: row.id, projectId: row.project_id, fromAgent: row.from_agent, toAgent: row.to_agent,
    type: row.type as MessageType, content: row.content, metadata: row.metadata,
    createdAt: row.created_at, processed: !!row.processed,
  }));
}

// ==================== LOGGING ====================

export function logCrewAction(projectId: number | null, agent: string, action: string, details: string): void {
  getCrewDb().prepare(`
    INSERT INTO crew_log (project_id, agent, action, details) VALUES (?, ?, ?, ?)
  `).run(projectId, agent, action, details);
}

export function getCrewLog(projectId?: number, limit = 50): Array<{ id: number; projectId: number | null; agent: string; action: string; details: string; createdAt: string }> {
  const query = projectId
    ? 'SELECT * FROM crew_log WHERE project_id = ? ORDER BY created_at DESC LIMIT ?'
    : 'SELECT * FROM crew_log ORDER BY created_at DESC LIMIT ?';
  const rows = (projectId
    ? getCrewDb().prepare(query).all(projectId, limit)
    : getCrewDb().prepare(query).all(limit)) as any[];
  return rows.map(r => ({
    id: r.id, projectId: r.project_id, agent: r.agent,
    action: r.action, details: r.details, createdAt: r.created_at,
  }));
}
