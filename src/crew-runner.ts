/**
 * Crew Runner — executes a single agent's task via the Claude Agent SDK.
 *
 * Each agent runs as its own Claude session with its own system prompt, tool
 * allow-list, and context. Results flow back through the message bus, and each
 * run is recorded so agents accumulate experience (see crew-learning.ts).
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { AGENTS, type AgentRole } from './crew.js';
import { getProject, getProjectTasks, getProjectMessages, logCrewAction } from './crew-db.js';
import { buildLearningContext, recordExperience, saveLesson } from './crew-learning.js';
import { PROJECT_ROOT } from './config.js';
import { logger } from './logger.js';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

const AGENT_MODELS: Record<string, string> = {
  opus: 'claude-opus-4-5',
  sonnet: 'claude-sonnet-4-5',
  haiku: 'claude-haiku-4-5',
};

// Load MCP servers from the project settings so agents can use them if allowed.
function loadMcpServers(): Record<string, any> {
  const settingsPath = resolve(PROJECT_ROOT, '.claude', 'settings.json');
  try {
    if (existsSync(settingsPath)) {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      return settings.mcpServers || {};
    }
  } catch {}
  return {};
}

export interface RunResult {
  success: boolean;
  output: string;
  error?: string;
  turnsUsed: number;
}

/**
 * Run an agent on a specific task.
 */
export async function runAgent(
  agentId: string,
  projectId: number,
  taskPrompt: string,
): Promise<RunResult> {
  const agent = AGENTS[agentId];
  if (!agent) {
    return { success: false, output: '', error: `Unknown agent: ${agentId}`, turnsUsed: 0 };
  }

  const project = getProject(projectId);
  if (!project) {
    return { success: false, output: '', error: `Project ${projectId} not found`, turnsUsed: 0 };
  }

  const tasks = getProjectTasks(projectId);
  const messages = getProjectMessages(projectId, 10);

  // Inject accumulated experience + skills into the prompt
  const learningCtx = buildLearningContext(agentId, taskPrompt);
  const context = buildAgentContext(agent, project, tasks, messages, taskPrompt) + learningCtx;

  logger.info({ agent: agentId, projectId, promptLen: context.length }, 'Running crew agent');
  logCrewAction(projectId, agentId, 'task_started', taskPrompt.substring(0, 200));

  try {
    const userMessage: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: context },
      parent_tool_use_id: null,
      session_id: `crew-${agentId}-project-${projectId}`,
    };

    const messageStream = (async function* () {
      yield userMessage;
    })();

    let output = '';
    let turnsUsed = 0;

    // Only expose the MCP servers this agent's tool list references.
    const mcpServers: Record<string, any> = {};
    const allMcp = loadMcpServers();
    for (const tool of agent.tools) {
      if (tool.startsWith('mcp__')) {
        const serverName = tool.split('__')[1];
        if (serverName && allMcp[serverName]) mcpServers[serverName] = allMcp[serverName];
      }
    }

    const agentSystemPrompt = agent.systemPrompt +
      `\nProject: "${project.title}" (ID: ${project.id})\nClient: ${project.clientName}\nStatus: ${project.status}\n`;

    const result = query({
      prompt: messageStream,
      options: {
        model: AGENT_MODELS[agent.model] || AGENT_MODELS.sonnet,
        systemPrompt: {
          type: 'preset' as const,
          preset: 'claude_code' as const,
          append: agentSystemPrompt,
        },
        allowedTools: agent.tools,
        mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
        maxTurns: agent.maxTurns,
        cwd: PROJECT_ROOT,
        permissionMode: 'bypassPermissions' as any,
        allowDangerouslySkipPermissions: true,
      },
    });

    for await (const event of result) {
      if (event.type === 'assistant') {
        const msg = event.message;
        if (msg.content) {
          for (const block of msg.content as any[]) {
            if (block.type === 'text') output += block.text + '\n';
          }
        }
        turnsUsed++;
      }
    }

    logCrewAction(projectId, agentId, 'task_completed', output.substring(0, 500));

    // Self-learning: record the success and save a lesson
    recordExperience(agentId, projectId, 'task', 'success', output.substring(0, 300));
    saveLesson(agentId, projectId, {
      taskTitle: taskPrompt.substring(0, 100),
      whatWorked: output.substring(0, 200),
      keyInsight: `Task completed in ${turnsUsed} turns`,
      tags: ['success', agentId],
    });

    return { success: true, output: output.trim(), turnsUsed };
  } catch (err: any) {
    const error = err.message || String(err);
    logger.error({ err, agent: agentId, projectId }, 'Agent run failed');
    logCrewAction(projectId, agentId, 'task_failed', error.substring(0, 500));

    recordExperience(agentId, projectId, 'task', 'failure', error.substring(0, 300));
    saveLesson(agentId, projectId, {
      taskTitle: taskPrompt.substring(0, 100),
      whatWorked: '',
      whatFailed: error.substring(0, 200),
      keyInsight: `Task failed: ${error.substring(0, 100)}`,
      tags: ['failure', agentId],
    });

    return { success: false, output: '', error, turnsUsed: 0 };
  }
}

/**
 * Build the full context prompt for an agent from project state and history.
 */
function buildAgentContext(
  agent: AgentRole,
  project: any,
  tasks: any[],
  messages: any[],
  taskPrompt: string,
): string {
  let ctx = `# Project: ${project.title}\n`;
  ctx += `Client: ${project.clientName} (${project.clientContact})\n`;
  ctx += `Status: ${project.status}\n`;

  if (project.requirements) ctx += `\n## Requirements\n${project.requirements}\n`;
  if (project.budget) ctx += `Budget: ${project.budget}\n`;
  if (project.deadline) ctx += `Deadline: ${project.deadline}\n`;

  if (tasks.length > 0) {
    ctx += `\n## Task history\n`;
    for (const t of tasks.slice(0, 5)) {
      ctx += `- [${t.status}] ${t.title} (${t.assignedTo}): ${(t.result || '').substring(0, 200)}\n`;
    }
  }

  if (messages.length > 0) {
    ctx += `\n## Recent crew messages\n`;
    for (const m of messages.slice(0, 5).reverse()) {
      ctx += `[${m.fromAgent} -> ${m.toAgent}] ${m.type}: ${m.content.substring(0, 300)}\n`;
    }
  }

  ctx += `\n## YOUR TASK\n${taskPrompt}\n`;
  ctx += `\nAnswer in a structured way: first what you did, then the result. If there are problems, describe them.\n`;

  return ctx;
}
