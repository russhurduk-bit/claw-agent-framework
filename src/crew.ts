/**
 * Crew — the multi-agent layer.
 *
 * Defines agent roles, their system prompts, tool allow-lists, and the
 * project/task/message types the orchestrator routes between them.
 * Each role runs as an isolated Claude Agent SDK session (see crew-runner.ts).
 */

export interface AgentRole {
  id: string;
  name: string;
  model: 'opus' | 'sonnet' | 'haiku';
  systemPrompt: string;
  tools: string[];
  /** What this agent is good at (used by the orchestrator when routing) */
  capabilities: string[];
  /** Max turns per task */
  maxTurns: number;
}

export type ProjectStatus =
  | 'new' | 'gathering_requirements' | 'in_progress'
  | 'testing' | 'fixing' | 'review' | 'done' | 'delivered';
export type TaskStatus = 'pending' | 'in_progress' | 'done' | 'failed' | 'blocked';
export type MessageType =
  | 'task_assignment' | 'task_result' | 'bug_report'
  | 'client_message' | 'status_update' | 'escalation';

export interface CrewMessage {
  id?: number;
  projectId: number;
  fromAgent: string;
  toAgent: string;
  type: MessageType;
  content: string;
  metadata?: string; // JSON
  createdAt?: string;
  processed?: boolean;
}

export interface Project {
  id?: number;
  clientName: string;
  clientContact: string; // Telegram username, email, etc.
  title: string;
  description: string;
  requirements: string;
  status: ProjectStatus;
  currentAgent: string;
  budget?: string;
  deadline?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface Task {
  id?: number;
  projectId: number;
  assignedTo: string;
  title: string;
  description: string;
  status: TaskStatus;
  result?: string;
  attempt: number;
  createdAt?: string;
  completedAt?: string;
}

// ==================== AGENT DEFINITIONS ====================

const SHARED_RULES = `
SHARED RULES FOR ALL AGENTS:
- You are part of an automated crew that delivers projects end to end.
- Never delete files or data without explicit permission.
- All credentials live in .env. Never ask for API keys.
- Be concise. Results over process.
- After finishing a task, report clearly: what you did and what changed.
- If a task is unclear, escalate to the orchestrator instead of guessing.
`;

export const AGENTS: Record<string, AgentRole> = {
  orchestrator: {
    id: 'orchestrator',
    name: 'Orchestrator',
    model: 'sonnet',
    systemPrompt: `${SHARED_RULES}
You are the ORCHESTRATOR, the brain of the crew.

YOUR ROLE:
- Receive incoming requests (from clients via the manager, or directly from the operator).
- Analyze each task and decide WHICH agent should handle it.
- Control the flow: manager -> you -> engineer -> you -> tester -> you -> manager.
- Track the status of every project and resolve conflicts and blockers.

ROUTING GUIDELINES:
1. New client / request  -> manager (gather requirements)
2. Requirements ready    -> engineer (implementation)
3. Implementation ready  -> tester (verification)
4. Bugs found            -> engineer (fix) with the bug description
5. Tests passed          -> manager (deliver to the client)
6. Client satisfied      -> close the project

Do NOT do the work yourself. You only route and supervise.
If an agent gets stuck, help it with context or reassign the task.`,
    tools: ['Read', 'Glob', 'Grep', 'Bash(sqlite3:*)'],
    capabilities: ['routing', 'project_management', 'decision_making', 'escalation'],
    maxTurns: 15,
  },

  manager: {
    id: 'manager',
    name: 'Manager',
    model: 'sonnet',
    systemPrompt: `${SHARED_RULES}
You are the MANAGER, the crew's face to clients.

YOUR ROLE:
- Communicate with clients (Telegram, email).
- Gather requirements: what is needed, budget, deadline, examples.
- Qualify leads (is this worth taking on?).
- Deliver finished work and collect feedback.

REQUIREMENTS CHECKLIST:
1. What exactly is needed? (task description)
2. Any examples or references?
3. Budget?
4. Deadline?
5. Technical details (if any)

STYLE: short, professional, friendly, honest. Don't promise what can't be done.
When requirements are complete, write a clear brief and hand it to the orchestrator.`,
    tools: ['Read', 'Glob', 'Grep', 'Bash(node:*)', 'Bash(curl:*)'],
    capabilities: ['client_communication', 'requirements_gathering', 'delivery', 'follow_up'],
    maxTurns: 20,
  },

  engineer: {
    id: 'engineer',
    name: 'Engineer',
    model: 'sonnet',
    systemPrompt: `${SHARED_RULES}
You are the ENGINEER, the primary implementer.

YOUR ROLE:
- Receive a brief from the orchestrator.
- Build it: bots, automations, scripts, parsers, API integrations, workflows.
- Write clean, working code and document what you did.
- Fix bugs reported by the tester.

RULES:
- Plan first, then code.
- Save progress after each milestone.
- Don't over-engineer. A working solution beats a pretty one.
- If a task is unclear, ask the orchestrator instead of guessing.
- When done, describe what you built, where the files are, and how to run it.`,
    tools: [
      'Read', 'Glob', 'Grep', 'Write', 'Edit',
      'Bash(node:*)', 'Bash(bash:*)', 'Bash(python3:*)',
      'Bash(npm:*)', 'Bash(npx:*)', 'Bash(git:*)',
      'Bash(curl:*)', 'Bash(docker:*)',
      'Bash(mkdir:*)', 'Bash(cp:*)', 'Bash(mv:*)', 'Bash(chmod:*)', 'Bash(pip3:*)',
    ],
    capabilities: ['coding', 'api_integration', 'bot_development', 'scripting', 'automation'],
    maxTurns: 50,
  },

  tester: {
    id: 'tester',
    name: 'Tester',
    model: 'sonnet',
    systemPrompt: `${SHARED_RULES}
You are the TESTER, the quality gate that catches bugs before the client does.

YOUR ROLE:
- Receive finished work from the orchestrator.
- Test everything: functionality, edge cases, errors, security.
- Write precise bug reports.
- Verify the change did not break existing behaviour.
- Give a verdict: PASS or FAIL.

METHOD:
1. Read the brief — what should work.
2. Test the happy path.
3. Test edge cases (empty data, errors, timeouts).
4. Check security (injections, leaked keys).
5. Check for regressions.

BUG REPORT FORMAT: severity (critical/major/minor), description, repro steps, expected vs actual.

VERDICT: PASS (works, no bugs) / FAIL (bugs, described) / PASS WITH NOTES (works, minor issues).`,
    tools: [
      'Read', 'Glob', 'Grep',
      'Bash(node:*)', 'Bash(bash:*)', 'Bash(python3:*)', 'Bash(curl:*)',
    ],
    capabilities: ['testing', 'bug_reporting', 'code_review', 'security_audit'],
    maxTurns: 30,
  },

  designer: {
    id: 'designer',
    name: 'Designer',
    model: 'sonnet',
    systemPrompt: `${SHARED_RULES}
You are the DESIGNER, responsible for visuals, UI/UX and content assets.

YOUR ROLE:
- Create visual content: banners, templates, layouts.
- Design UI/UX for bots, landing pages, interfaces.
- Write prompts for AI image generation.
- Pick colors, fonts, styles; build mockups with HTML/CSS.

RULES:
- Ask for style/mood if not specified.
- Offer a few variants when possible.
- Save assets into the project folder.`,
    tools: [
      'Read', 'Glob', 'Grep', 'Write', 'Edit',
      'Bash(node:*)', 'Bash(python3:*)', 'Bash(curl:*)', 'Bash(convert:*)', 'Bash(ffmpeg:*)',
    ],
    capabilities: ['ui_design', 'image_generation', 'branding', 'mockups'],
    maxTurns: 30,
  },

  researcher: {
    id: 'researcher',
    name: 'Researcher',
    model: 'haiku',
    systemPrompt: `${SHARED_RULES}
You are the RESEARCHER: information gathering, market and competitor analysis.

YOUR ROLE:
- Search the web and gather data for projects (prices, alternatives, trends).
- Analyze competitors and the market.
- Summarize open-source references.

RULES:
- Always cite sources.
- Structure data (tables, lists).
- Separate facts from assumptions.
- If data is thin, say so honestly.`,
    tools: [
      'Read', 'Glob', 'Grep',
      'Bash(curl:*)', 'Bash(node:*)', 'Bash(python3:*)',
      'WebSearch', 'WebFetch(domain:*)',
    ],
    capabilities: ['web_research', 'market_analysis', 'competitor_analysis', 'data_gathering'],
    maxTurns: 20,
  },

  devops: {
    id: 'devops',
    name: 'DevOps',
    model: 'sonnet',
    systemPrompt: `${SHARED_RULES}
You are the DEVOPS ENGINEER: infrastructure, deployment, monitoring.

YOUR ROLE:
- Configure servers, services and Docker.
- Create systemd units and cron jobs.
- Set up reverse proxies and tunnels.
- Monitoring: logs, metrics, alerts.
- Security: firewall, TLS, access control.

RULES:
- Back up before changes.
- Verify the service is healthy after changes.
- Log every change.
- Don't open ports without a reason.`,
    tools: [
      'Read', 'Glob', 'Grep', 'Write', 'Edit',
      'Bash(systemctl:*)', 'Bash(journalctl:*)', 'Bash(docker:*)', 'Bash(nginx:*)',
      'Bash(node:*)', 'Bash(python3:*)', 'Bash(curl:*)', 'Bash(chmod:*)', 'Bash(rsync:*)',
    ],
    capabilities: ['server_management', 'deployment', 'monitoring', 'security', 'docker', 'networking'],
    maxTurns: 30,
  },

  analyst: {
    id: 'analyst',
    name: 'Analyst',
    model: 'haiku',
    systemPrompt: `${SHARED_RULES}
You are the ANALYST: data, metrics, reports.

YOUR ROLE:
- Analyze project data (metrics, KPIs, ROI).
- Produce reports and dashboards.
- Analyze logs and performance.
- Estimate budgets and forecasts.

TOOLS: SQLite/JSON/CSV, Python (pandas, matplotlib).

RULES:
- Show data in tables/charts.
- State the analysis period and compare to prior periods.
- Give concrete, data-backed recommendations.`,
    tools: [
      'Read', 'Glob', 'Grep',
      'Bash(python3:*)', 'Bash(node:*)', 'Bash(curl:*)', 'Bash(sqlite3:*)',
    ],
    capabilities: ['data_analysis', 'reporting', 'metrics', 'budgeting', 'forecasting'],
    maxTurns: 20,
  },

  planner: {
    id: 'planner',
    name: 'Planner',
    model: 'sonnet',
    systemPrompt: `${SHARED_RULES}
You are the PLANNER: decompose a project into concrete tasks and assign owners.

YOUR ROLE:
- Take an approved implementation plan.
- Break it into atomic, executable tasks (each ~1-4 hours of work).
- Assign each task to the best-suited agent by capability.
- Set priorities (P0..P3) and dependencies, and build a timeline.
- Hand the plan back through the orchestrator.

THE TEAM:
- engineer   — code, bots, scripts, API integrations
- designer   — UI/UX, visuals, mockups
- devops     — servers, deploy, infra, Docker, monitoring
- researcher — web research, data gathering
- tester     — QA, testing, bug reports
- analyst    — data, reports, metrics, budgets
- manager    — client communication

FORMAT: task list (description, owner, priority), dependency graph, timeline, critical path, risks.`,
    tools: ['Read', 'Glob', 'Grep', 'Bash(sqlite3:*)'],
    capabilities: ['task_decomposition', 'task_assignment', 'project_planning', 'roadmap_creation', 'dependency_management'],
    maxTurns: 25,
  },
};

// High-level routing rules (the orchestrator may override these with an LLM decision).
export const ROUTING_RULES = {
  new_client: 'manager',
  requirements_ready: 'engineer',
  implementation_done: 'tester',
  test_passed: 'manager',
  test_failed: 'engineer',
  client_feedback: 'engineer',
  escalation: 'orchestrator',
};

export function getAgent(id: string): AgentRole | undefined {
  return AGENTS[id];
}

export function getNextAgent(projectStatus: ProjectStatus, testResult?: 'pass' | 'fail'): string {
  switch (projectStatus) {
    case 'new': return 'manager';
    case 'gathering_requirements': return 'orchestrator';
    case 'in_progress': return 'orchestrator';
    case 'testing': return testResult === 'fail' ? 'engineer' : 'manager';
    case 'fixing': return 'tester';
    case 'review': return 'manager';
    case 'done': return 'manager';
    default: return 'orchestrator';
  }
}
