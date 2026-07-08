/**
 * Crew Orchestrator — the brain of the multi-agent system.
 *
 * Drains the message queue, routes tasks between agents, manages the project
 * lifecycle, and runs as a background daemon (see crew-cli.ts `daemon`).
 *
 * Routing is LLM-driven when GOOGLE_API_KEY is set (a cheap model picks the next
 * agent), with a deterministic state-machine fallback so the crew keeps moving
 * even with no external model configured.
 */

import {
  initCrewDb,
  createProject, getProject, updateProjectStatus, updateProjectRequirements,
  createTask, updateTaskStatus, getProjectTasks,
  sendCrewMessage, getPendingMessages, markMessageProcessed, getProjectMessages,
  listProjects, logCrewAction,
} from './crew-db.js';
import { AGENTS, type ProjectStatus, type MessageType } from './crew.js';
import { runAgent } from './crew-runner.js';
import { GOOGLE_API_KEY, ADMIN_CHAT_ID, TELEGRAM_BOT_TOKEN } from './config.js';
import { logger } from './logger.js';

const POLL_INTERVAL = 10_000; // 10 seconds

/**
 * Notify the operator out of band. Sends a Telegram message when ADMIN_CHAT_ID
 * and a bot token are configured; otherwise just logs.
 */
async function notifyAdmin(text: string): Promise<void> {
  if (ADMIN_CHAT_ID && TELEGRAM_BOT_TOKEN) {
    try {
      const { sendTelegramMessage } = await import('./bot.js');
      await sendTelegramMessage(ADMIN_CHAT_ID, text);
      return;
    } catch (err) {
      logger.warn({ err }, 'Failed to notify admin via Telegram');
    }
  }
  logger.info({ notify: text }, 'Admin notification');
}

/**
 * Process a single message from the queue.
 */
async function processMessage(msg: any): Promise<void> {
  const project = getProject(msg.projectId);
  if (!project) {
    logger.warn({ msgId: msg.id, projectId: msg.projectId }, 'Message for unknown project');
    markMessageProcessed(msg.id);
    return;
  }

  logger.info({
    msgId: msg.id, from: msg.fromAgent, to: msg.toAgent,
    type: msg.type, projectId: msg.projectId,
  }, 'Processing crew message');

  const targetAgent = msg.toAgent;

  switch (msg.type as MessageType) {
    case 'task_assignment': {
      const taskId = createTask({
        projectId: msg.projectId,
        assignedTo: targetAgent,
        title: `${msg.type} from ${msg.fromAgent}`,
        description: msg.content,
        status: 'in_progress',
        attempt: 1,
      });

      updateProjectStatus(msg.projectId, getStatusForAgent(targetAgent), targetAgent);

      const result = await runAgent(targetAgent, msg.projectId, msg.content);

      if (result.success) {
        updateTaskStatus(taskId, 'done', result.output);
        // Route the result back to the orchestrator (unless this IS the orchestrator)
        if (targetAgent !== 'orchestrator') {
          sendCrewMessage({
            projectId: msg.projectId,
            fromAgent: targetAgent,
            toAgent: 'orchestrator',
            type: 'task_result',
            content: result.output,
            metadata: JSON.stringify({ taskId, turnsUsed: result.turnsUsed }),
          });
        }
      } else {
        updateTaskStatus(taskId, 'failed', result.error || 'Unknown error');
        sendCrewMessage({
          projectId: msg.projectId,
          fromAgent: targetAgent,
          toAgent: 'orchestrator',
          type: 'escalation',
          content: `Task failed: ${result.error}`,
        });
      }
      break;
    }

    case 'task_result': {
      if (targetAgent === 'orchestrator') {
        await handleOrchestratorDecision(msg, project);
      }
      break;
    }

    case 'bug_report': {
      updateProjectStatus(msg.projectId, 'fixing', 'engineer');
      sendCrewMessage({
        projectId: msg.projectId,
        fromAgent: 'orchestrator',
        toAgent: 'engineer',
        type: 'task_assignment',
        content: `BUGS FOUND BY THE TESTER. Fix them:\n\n${msg.content}\n\nProject: ${project.title}\nRequirements: ${project.requirements}`,
      });
      await notifyAdmin(`Project "${project.title}": tester found bugs, engineer is fixing.`);
      break;
    }

    case 'client_message': {
      if (targetAgent === 'orchestrator') {
        sendCrewMessage({
          projectId: msg.projectId,
          fromAgent: 'orchestrator',
          toAgent: 'manager',
          type: 'task_assignment',
          content: `Message from client ${project.clientName}:\n\n${msg.content}\n\nReply to the client.`,
        });
      }
      break;
    }

    case 'status_update': {
      logCrewAction(msg.projectId, msg.fromAgent, 'status_update', msg.content);
      break;
    }

    case 'escalation': {
      await notifyAdmin(`Escalation in "${project.title}" from ${msg.fromAgent}: ${msg.content.substring(0, 200)}`);
      logCrewAction(msg.projectId, msg.fromAgent, 'escalation', msg.content);
      break;
    }
  }

  markMessageProcessed(msg.id);
}

/**
 * LLM-driven routing. Asks a cheap model to pick the next agent based on the
 * current project context. Falls back to the deterministic router on any error.
 */
async function handleOrchestratorDecision(msg: any, project: any): Promise<void> {
  const fromAgent = msg.fromAgent;
  const resultContent = msg.content;
  const tasks = getProjectTasks(project.id);

  const agentList = Object.values(AGENTS)
    .map(a => `- ${a.id} (${a.name}): ${a.capabilities.join(', ')}`)
    .join('\n');

  const taskHistory = tasks.slice(0, 5)
    .map(t => `[${t.status}] ${t.assignedTo}: ${(t.result || t.description || '').substring(0, 150)}`)
    .join('\n');

  const decisionPrompt = `You are the Orchestrator. Decide what happens next.

PROJECT: "${project.title}" (ID: ${project.id})
Client: ${project.clientName} (${project.clientContact})
Status: ${project.status}
Requirements: ${(project.requirements || 'not gathered').substring(0, 500)}

JUST FINISHED: ${fromAgent}
RESULT:
${resultContent.substring(0, 1000)}

TASK HISTORY:
${taskHistory || 'empty'}

AVAILABLE AGENTS:
${agentList}

RULES:
1. Every request flows through you. You decide who gets it.
2. Manager finished requirements -> route to the best fit (engineer for code, designer for visuals, researcher for research).
3. Work done -> send to the tester.
4. Tester found bugs -> return to the implementer with the bug list.
5. Tests passed -> hand to the manager for delivery.
6. Complex work can be split into subtasks across agents.

Reply STRICTLY as JSON:
{
  "next_agent": "agent_id",
  "task": "task description for the agent",
  "new_status": "new|gathering_requirements|in_progress|testing|fixing|review|done|delivered",
  "notify_admin": "short message for the operator (or null)",
  "update_requirements": true/false,
  "reasoning": "why you chose this agent"
}`;

  if (!GOOGLE_API_KEY) {
    await fallbackRouting(fromAgent, project, resultContent);
    return;
  }

  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GOOGLE_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: decisionPrompt }] }],
          generationConfig: { temperature: 0.1 },
        }),
        signal: AbortSignal.timeout(30000),
      }
    );

    const geminiJson = await resp.json() as any;
    const responseText = geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text || '';

    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn({ response: responseText.substring(0, 200) }, 'Router returned no JSON, using fallback');
      await fallbackRouting(fromAgent, project, resultContent);
      return;
    }

    const decision = JSON.parse(jsonMatch[0]);
    logger.info({
      projectId: project.id,
      nextAgent: decision.next_agent,
      reasoning: decision.reasoning?.substring(0, 100),
    }, 'Orchestrator decision');

    if (decision.update_requirements && resultContent) {
      updateProjectRequirements(project.id, resultContent);
    }
    if (decision.new_status) {
      updateProjectStatus(project.id, decision.new_status as ProjectStatus, decision.next_agent);
    }
    if (decision.next_agent && decision.task) {
      sendCrewMessage({
        projectId: project.id,
        fromAgent: 'orchestrator',
        toAgent: decision.next_agent,
        type: 'task_assignment',
        content: decision.task,
        metadata: JSON.stringify({ reasoning: decision.reasoning }),
      });
    }
    if (decision.notify_admin) {
      await notifyAdmin(decision.notify_admin);
    }

    logCrewAction(project.id, 'orchestrator', 'ai_routing',
      `${fromAgent} -> ${decision.next_agent}: ${decision.reasoning?.substring(0, 150)}`);
  } catch (err: any) {
    logger.error({ err: err.message?.substring(0, 200) }, 'Router failed, using fallback');
    await fallbackRouting(fromAgent, project, resultContent);
  }
}

/**
 * Deterministic fallback router (finite state machine).
 */
async function fallbackRouting(fromAgent: string, project: any, resultContent: string): Promise<void> {
  let nextAgent = 'engineer';
  let task = resultContent;
  let status: ProjectStatus = 'in_progress';

  if (fromAgent === 'manager' && (project.status === 'new' || project.status === 'gathering_requirements')) {
    nextAgent = 'engineer';
    task = `Implement the project:\n\n${resultContent}`;
    status = 'in_progress';
    updateProjectRequirements(project.id, resultContent);
  } else if (fromAgent === 'engineer' || fromAgent === 'designer') {
    nextAgent = 'tester';
    task = `Test this:\n\nBrief: ${project.requirements?.substring(0, 300)}\n\nDone:\n${resultContent}`;
    status = 'testing';
  } else if (fromAgent === 'tester') {
    const isPassed = /\bPASS\b/i.test(resultContent) && !/\bFAIL\b/i.test(resultContent);
    if (isPassed) {
      nextAgent = 'manager';
      task = `Project is ready! Deliver it to client ${project.clientName}.\n\n${resultContent.substring(0, 500)}`;
      status = 'done';
    } else {
      nextAgent = 'engineer';
      task = `Bugs from the tester, fix them:\n\n${resultContent}`;
      status = 'fixing';
    }
  } else if (fromAgent === 'manager' && (project.status === 'done' || project.status === 'review')) {
    updateProjectStatus(project.id, 'delivered', 'manager');
    await notifyAdmin(`"${project.title}" delivered to the client.`);
    return;
  }

  updateProjectStatus(project.id, status, nextAgent);
  sendCrewMessage({
    projectId: project.id,
    fromAgent: 'orchestrator',
    toAgent: nextAgent,
    type: 'task_assignment',
    content: task,
  });
}

function getStatusForAgent(agentId: string): ProjectStatus {
  switch (agentId) {
    case 'manager': return 'gathering_requirements';
    case 'engineer': return 'in_progress';
    case 'tester': return 'testing';
    default: return 'in_progress';
  }
}

// ==================== PUBLIC API ====================

/** Start a new project from a client request. */
export function startProject(clientName: string, clientContact: string, title: string, description: string): number {
  initCrewDb();

  const projectId = createProject({
    clientName,
    clientContact,
    title,
    description,
    requirements: '',
    status: 'new',
    currentAgent: 'manager',
  });

  sendCrewMessage({
    projectId,
    fromAgent: 'orchestrator',
    toAgent: 'manager',
    type: 'task_assignment',
    content: `New client! Gather requirements.\n\nClient: ${clientName} (${clientContact})\nRequest: ${description}\n\nClarify: what exactly is needed, budget, deadline, examples. Write a brief.`,
  });

  logCrewAction(projectId, 'orchestrator', 'project_created', `Client: ${clientName}, Title: ${title}`);
  return projectId;
}

/** Handle an incoming client message for an existing project. */
export function handleClientMessage(projectId: number, message: string): void {
  sendCrewMessage({
    projectId,
    fromAgent: 'client',
    toAgent: 'orchestrator',
    type: 'client_message',
    content: message,
  });
}

/** Human-readable status summary for a project. */
export function getProjectSummary(projectId: number): string {
  const project = getProject(projectId);
  if (!project) return 'Project not found';

  const tasks = getProjectTasks(projectId);

  let summary = `**${project.title}**\n`;
  summary += `Client: ${project.clientName}\n`;
  summary += `Status: ${project.status} (${project.currentAgent})\n`;
  if (project.budget) summary += `Budget: ${project.budget}\n`;
  if (project.deadline) summary += `Deadline: ${project.deadline}\n`;

  if (tasks.length > 0) {
    summary += `\nTasks:\n`;
    for (const t of tasks.slice(0, 5)) {
      summary += `  [${t.status}] ${t.assignedTo}: ${t.title.substring(0, 60)}\n`;
    }
  }
  return summary;
}

/** List all active projects. */
export function getActiveProjects(): string {
  const projects = listProjects();
  if (projects.length === 0) return 'No active projects';
  return projects.map(p =>
    `#${p.id} "${p.title}" — ${p.status} (${p.currentAgent}) — ${p.clientName}`
  ).join('\n');
}

// ==================== DAEMON ====================

let running = false;

/** Main processing loop — runs in the background. */
export async function startOrchestrator(): Promise<void> {
  initCrewDb();
  running = true;
  logger.info('Crew Orchestrator started');

  while (running) {
    try {
      // Orchestrator messages first, then everyone else
      for (const msg of getPendingMessages('orchestrator')) {
        await processMessage(msg);
      }
      for (const agentId of Object.keys(AGENTS)) {
        if (agentId === 'orchestrator') continue;
        for (const msg of getPendingMessages(agentId)) {
          await processMessage(msg);
        }
      }
    } catch (err) {
      logger.error({ err }, 'Orchestrator loop error');
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
}

export function stopOrchestrator(): void {
  running = false;
  logger.info('Crew Orchestrator stopping');
}
