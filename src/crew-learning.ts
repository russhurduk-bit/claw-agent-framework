/**
 * Crew Learning — agents get better with experience.
 *
 * After each task an agent records what worked / what failed as a "lesson".
 * Before each task, relevant past lessons and installed skills are injected
 * into the agent's prompt. Everything is stored locally in crew.db, so the
 * crew is fully self-contained (no external memory service required).
 */

import { initCrewDb, getCrewDb, sendCrewMessage, logCrewAction } from './crew-db.js';
import { logger } from './logger.js';

// ==================== TABLES ====================

export function ensureLearningTables(): void {
  const db = getCrewDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_skills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      skill_description TEXT NOT NULL,
      skill_file TEXT DEFAULT '',
      installed_by TEXT DEFAULT 'orchestrator',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(agent_id, skill_name)
    );

    CREATE TABLE IF NOT EXISTS agent_experience (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      project_id INTEGER,
      task_type TEXT NOT NULL,
      outcome TEXT NOT NULL,
      lesson TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS agent_lessons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      project_id INTEGER,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

// ==================== LESSONS ====================

/**
 * Save a lesson learned after a task completes.
 */
export function saveLesson(agentId: string, projectId: number, lesson: {
  taskTitle: string;
  whatWorked: string;
  whatFailed?: string;
  keyInsight: string;
  tags: string[];
}): void {
  try {
    ensureLearningTables();
    const content = [
      `Agent: ${agentId}`,
      `Project #${projectId}: ${lesson.taskTitle}`,
      '',
      `What worked: ${lesson.whatWorked}`,
      lesson.whatFailed ? `What failed: ${lesson.whatFailed}` : '',
      `Key insight: ${lesson.keyInsight}`,
    ].filter(Boolean).join('\n');

    const tags = ['crew-learning', `agent-${agentId}`, ...lesson.tags].join(',');
    const title = `[${agentId}] ${lesson.keyInsight.substring(0, 80)}`;

    getCrewDb().prepare(`
      INSERT INTO agent_lessons (agent_id, project_id, title, content, tags)
      VALUES (?, ?, ?, ?, ?)
    `).run(agentId, projectId, title, content, tags);

    logger.info({ agentId, projectId }, 'Lesson saved');
  } catch (err) {
    logger.warn({ err, agentId }, 'Failed to save lesson');
  }
}

/**
 * Retrieve relevant past lessons for an agent before it starts a task.
 * Simple keyword scoring over the local lessons table.
 */
export function getRelevantExperience(agentId: string, taskDescription: string, limit = 5): string[] {
  try {
    ensureLearningTables();
    const keywords = taskDescription
      .split(/\s+/)
      .filter(w => w.length > 3)
      .slice(0, 5)
      .map(w => `%${w.replace(/[%_]/g, '')}%`);

    const db = getCrewDb();
    const rows = db.prepare(`
      SELECT title, content FROM agent_lessons
      WHERE agent_id = ? OR tags LIKE '%crew-learning%'
      ORDER BY created_at DESC
      LIMIT 100
    `).all(agentId) as Array<{ title: string; content: string }>;

    // Rank by keyword overlap
    const scored = rows.map(r => {
      const hay = (r.title + ' ' + r.content).toLowerCase();
      const score = keywords.reduce((s, k) => s + (hay.includes(k.slice(1, -1).toLowerCase()) ? 1 : 0), 0);
      return { ...r, score };
    });

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .filter(r => r.score > 0 || rows.length <= limit)
      .map(r => `--- ${r.title} ---\n${r.content.substring(0, 300)}`);
  } catch {
    return [];
  }
}

// ==================== SKILL REQUESTS ====================

/**
 * An agent asks the orchestrator to install a new skill/tool it needs.
 */
export function requestSkill(agentId: string, projectId: number, skillDescription: string): void {
  initCrewDb();
  sendCrewMessage({
    projectId,
    fromAgent: agentId,
    toAgent: 'orchestrator',
    type: 'task_assignment',
    content: `SKILL REQUEST from ${agentId}:\n\n${skillDescription}\n\nInstall the needed tool/library and document how to use it.`,
    metadata: JSON.stringify({ type: 'skill_request', requestedBy: agentId }),
  });
  logCrewAction(projectId, agentId, 'skill_requested', skillDescription.substring(0, 200));
  logger.info({ agentId, projectId }, `Skill requested: ${skillDescription.substring(0, 80)}`);
}

// ==================== AGENT SKILLS ====================

export function addAgentSkill(agentId: string, skillName: string, description: string, skillFile = ''): void {
  ensureLearningTables();
  getCrewDb().prepare(`
    INSERT OR REPLACE INTO agent_skills (agent_id, skill_name, skill_description, skill_file)
    VALUES (?, ?, ?, ?)
  `).run(agentId, skillName, description, skillFile);
  logCrewAction(null, 'orchestrator', 'skill_installed', `${skillName} -> ${agentId}`);
}

export function getAgentSkills(agentId: string): Array<{ name: string; description: string; file: string }> {
  ensureLearningTables();
  const rows = getCrewDb()
    .prepare('SELECT skill_name, skill_description, skill_file FROM agent_skills WHERE agent_id = ?')
    .all(agentId) as any[];
  return rows.map(r => ({ name: r.skill_name, description: r.skill_description, file: r.skill_file }));
}

export function recordExperience(
  agentId: string, projectId: number, taskType: string,
  outcome: 'success' | 'failure', lesson: string,
): void {
  ensureLearningTables();
  getCrewDb().prepare(`
    INSERT INTO agent_experience (agent_id, project_id, task_type, outcome, lesson)
    VALUES (?, ?, ?, ?, ?)
  `).run(agentId, projectId, taskType, outcome, lesson);
}

export function getAgentStats(agentId: string): { totalTasks: number; successes: number; failures: number; skills: number } {
  ensureLearningTables();
  const db = getCrewDb();

  const exp = db.prepare('SELECT outcome, COUNT(*) as cnt FROM agent_experience WHERE agent_id = ? GROUP BY outcome')
    .all(agentId) as any[];
  const skillCount = (db.prepare('SELECT COUNT(*) as cnt FROM agent_skills WHERE agent_id = ?').get(agentId) as any)?.cnt || 0;

  let successes = 0, failures = 0;
  for (const e of exp) {
    if (e.outcome === 'success') successes = e.cnt;
    if (e.outcome === 'failure') failures = e.cnt;
  }
  return { totalTasks: successes + failures, successes, failures, skills: skillCount };
}

// ==================== PROMPT INJECTION ====================

/**
 * Build the "memory context" injected into an agent's prompt before a task.
 * This is what makes agents smarter over time.
 */
export function buildLearningContext(agentId: string, taskDescription: string): string {
  const skills = getAgentSkills(agentId);
  const stats = getAgentStats(agentId);
  const experience = getRelevantExperience(agentId, taskDescription);

  let ctx = '\n## YOUR EXPERIENCE AND SKILLS\n';

  if (stats.totalTasks > 0) {
    ctx += `Stats: ${stats.totalTasks} tasks, ${stats.successes} succeeded, ${stats.failures} failed\n`;
  }
  if (skills.length > 0) {
    ctx += `\nInstalled skills:\n`;
    for (const s of skills) ctx += `- ${s.name}: ${s.description}${s.file ? ` (file: ${s.file})` : ''}\n`;
  }
  if (experience.length > 0) {
    ctx += `\nRelevant past experience:\n${experience.join('\n').substring(0, 1000)}\n`;
  }

  ctx += `\nAFTER FINISHING THE TASK:\n`;
  ctx += `1. Note what worked and what didn't.\n`;
  ctx += `2. If you lack a tool, request a skill from the orchestrator.\n`;

  return ctx;
}
