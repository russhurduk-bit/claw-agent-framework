import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { PROJECT_ROOT } from './config.js';
import { logger } from './logger.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface AgentResult {
  text: string | null;
  newSessionId?: string;
  toolsUsed?: string[];
  turnCount?: number;
}

export interface ImageAttachment {
  path: string;
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
}

// --- Agent configuration ---

const AGENT_MODEL = process.env.CLAW_AGENT_MODEL ?? 'claude-sonnet-4-5';
const FALLBACK_MODEL = process.env.CLAW_FALLBACK_MODEL ?? 'claude-haiku-4-5';
const MAX_THINKING_TOKENS = 10000;
const MAX_TURNS = 25;

// Keywords that hint the request needs external MCP tools (used for logging/telemetry).
const MCP_KEYWORDS = /workflow|automation|integration|deploy|pipeline/i;

/**
 * Skill auto-loading: match the user's message against keyword patterns and
 * inline the matching skill file from `.claude/skills/` into the system prompt.
 * This is a lightweight, dependency-free alternative to a full RAG retriever.
 * Add your own domain skills here — these are illustrative examples only.
 */
const SKILL_KEYWORDS: Array<{ pattern: RegExp; file: string }> = [
  { pattern: /workflow|automation|n8n/i, file: 'automation.md' },
  { pattern: /research|compare|find out|investigate/i, file: 'research.md' },
  { pattern: /deploy|server|docker|systemd|nginx/i, file: 'devops.md' },
];

function loadMatchingSkills(message: string): string {
  const skills: string[] = [];
  const skillsDir = resolve(PROJECT_ROOT, '.claude', 'skills');

  for (const { pattern, file } of SKILL_KEYWORDS) {
    if (pattern.test(message)) {
      const filePath = resolve(skillsDir, file);
      try {
        if (existsSync(filePath)) {
          const content = readFileSync(filePath, 'utf-8');
          skills.push(`\n--- SKILL: ${file} ---\n${content}\n--- END SKILL ---`);
          logger.info({ skill: file }, 'Auto-loaded skill for message');
        }
      } catch (err) {
        logger.warn({ err, skill: file }, 'Failed to load skill file');
      }
    }
  }

  return skills.join('\n');
}

/**
 * Load MCP server configs from the project's `.claude/settings.json`.
 * Any MCP servers you configure there become available to the agent.
 */
function loadMcpServers(): Record<string, any> {
  const settingsPath = resolve(PROJECT_ROOT, '.claude', 'settings.json');
  try {
    if (existsSync(settingsPath)) {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      if (settings.mcpServers && typeof settings.mcpServers === 'object') {
        logger.info({ servers: Object.keys(settings.mcpServers) }, 'Loaded MCP servers from project settings');
        return settings.mcpServers;
      }
    }
  } catch (err) {
    logger.error({ err, path: settingsPath }, 'Failed to load MCP servers from settings');
  }
  return {};
}

// System prompt appended to the Claude Code preset. Keep it short and behavioural.
const SYSTEM_APPEND = `
You are Claw, a personal AI assistant that runs as a persistent service and is reachable over Telegram.

Operating rules (always active):
- Reply in the same language the user writes to you.
- You have shell and file-system access on the host. Execute tasks, don't just describe them.
- Read configuration and secrets from the project's .env. Never ask the user for API keys.
- Never delete files or data without explicit permission.
- Be concise. Prefer results over narration.
- If you don't know something, say so plainly.

When the user sends an image, video frames, or a document, they are provided in-context. Analyze them directly.
`.trim();

// Tools pre-allowed for instant execution (no permission prompt).
// Trim or expand this list to match your risk tolerance.
const ALLOWED_TOOLS = [
  'Read', 'Glob', 'Grep', 'Write', 'Edit',
  'Bash(node:*)', 'Bash(bash:*)',
  'Bash(curl:*)', 'Bash(ffmpeg:*)', 'Bash(ffprobe:*)',
  'Bash(ls:*)', 'Bash(mkdir:*)', 'Bash(cp:*)', 'Bash(mv:*)',
  'Bash(head:*)', 'Bash(tail:*)', 'Bash(wc:*)', 'Bash(du:*)',
  'Bash(grep:*)', 'Bash(find:*)', 'Bash(sort:*)',
  'Bash(npm:*)', 'Bash(npx:*)', 'Bash(git:*)',
  'Bash(python3:*)', 'Bash(pip3:*)',
  'WebSearch', 'WebFetch(domain:*)',
];

// Custom specialized subagents the main agent can delegate to.
const CUSTOM_AGENTS: Record<string, any> = {
  'code-writer': {
    description: 'Writes and debugs code. TypeScript, Node.js, Python, shell scripts.',
    prompt: 'You are a code writer. Write, debug, and improve code as requested.',
    model: 'sonnet',
    tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash'],
  },
  'researcher': {
    description: 'Deep web research and data gathering from multiple sources.',
    prompt: 'You are a researcher. Search the web and gather information from multiple sources, always citing them.',
    model: 'haiku',
    tools: ['Read', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch'],
  },
};

// --- Multimodal prompt builder ---

function buildMultimodalPrompt(
  text: string,
  images: ImageAttachment[],
  sessionId?: string
): AsyncIterable<SDKUserMessage> {
  const contentParts: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  > = [];

  for (const img of images) {
    try {
      const data = readFileSync(img.path).toString('base64');
      contentParts.push({
        type: 'image',
        source: { type: 'base64', media_type: img.mediaType, data },
      });
    } catch (err) {
      logger.error({ err, path: img.path }, 'Failed to read image');
    }
  }

  contentParts.push({ type: 'text', text });

  const message: SDKUserMessage = {
    type: 'user',
    message: { role: 'user', content: contentParts as any },
    parent_tool_use_id: null,
    session_id: sessionId ?? '',
  };

  return {
    async *[Symbol.asyncIterator]() {
      yield message;
    },
  };
}

// --- Main agent runner ---

export async function runAgent(
  message: string,
  sessionId?: string,
  onTyping?: () => void,
  images?: ImageAttachment[],
  systemAppendOverride?: string,
  modelOverride?: string
): Promise<AgentResult> {
  let resultText: string | null = null;
  let newSessionId: string | undefined;
  const toolsUsed: string[] = [];
  let turnCount = 0;

  // Keep the "typing…" indicator alive while the agent works.
  let typingInterval: ReturnType<typeof setInterval> | undefined;
  if (onTyping) {
    onTyping();
    typingInterval = setInterval(onTyping, 4000);
  }

  try {
    const prompt = images && images.length > 0
      ? buildMultimodalPrompt(message, images, sessionId)
      : message;

    const needsMcp = MCP_KEYWORDS.test(message);
    if (needsMcp) {
      logger.info('Request looks MCP-shaped; servers load via settingSources');
    }

    // Auto-load relevant skill files based on message keywords
    const skillContext = systemAppendOverride ? '' : loadMatchingSkills(message);
    const baseAppend = systemAppendOverride ?? SYSTEM_APPEND;
    const systemAppend = skillContext
      ? baseAppend + '\n\nAUTO-LOADED SKILLS (use these to handle the request):\n' + skillContext
      : baseAppend;

    const events = query({
      prompt,
      options: {
        // Model config
        model: modelOverride ?? AGENT_MODEL,
        fallbackModel: FALLBACK_MODEL,
        maxThinkingTokens: MAX_THINKING_TOKENS,
        maxTurns: MAX_TURNS,

        // System prompt: Claude Code preset + our behavioural append
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: systemAppend,
        },

        // Tool config
        allowedTools: ALLOWED_TOOLS,

        // Custom subagents
        agents: CUSTOM_AGENTS,

        // Execution environment
        cwd: PROJECT_ROOT,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        // 'project' loads the project's config incl. MCP servers from .claude/settings.json
        settingSources: ['project', 'user'],

        // Session resume
        ...(sessionId ? { resume: sessionId } : {}),

        // Pass through the process environment
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(([k]) => k !== 'CLAUDECODE')
          ),
        },

        // Hook: record which tools were used, for telemetry / debugging
        hooks: {
          PostToolUse: [{
            hooks: [async (input: any) => {
              const toolName = input?.tool?.name ?? 'unknown';
              toolsUsed.push(toolName);
              logger.debug({ tool: toolName }, 'Tool used');
              return {};
            }],
          }],
        },

        stderr: (msg: string) => {
          const trimmed = msg.trim();
          if (trimmed) {
            logger.warn({ stderr: trimmed }, 'Agent subprocess stderr');
          }
        },
      } as any,
    });

    for await (const event of events) {
      if (event.type === 'system' && event.subtype === 'init') {
        newSessionId = event.session_id;
        logger.debug({ sessionId: newSessionId }, 'Session initialized');
      }

      if (event.type === 'assistant') {
        turnCount++;
      }

      if (event.type === 'result' && event.subtype === 'success') {
        resultText = event.result ?? null;
        logger.info({ turns: turnCount, tools: toolsUsed.length }, 'Agent completed');
      } else if (event.type === 'result') {
        const errors = (event as any).errors ?? [];
        logger.warn({ subtype: event.subtype, turns: turnCount, errors }, 'Agent returned non-success result');
        if (event.subtype === 'error_max_turns') {
          resultText = (event as any).result ?? 'This task exceeded the step limit. Try breaking it into smaller parts.';
        } else if (errors.length > 0) {
          resultText = (event as any).result ?? `Error: ${errors.join('; ')}`;
        } else {
          resultText = (event as any).result ?? 'Something went wrong while processing your request.';
        }
      }
    }
  } catch (err: any) {
    const isExitCode1 = err?.message?.includes('exited with code 1');
    if (isExitCode1 && sessionId) {
      // Session resume crashed — clear it so callers can retry without a session.
      logger.warn({ sessionId }, 'CLI crashed on session resume, clearing session');
      try {
        const { getDb } = await import('./db.js');
        getDb().prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId);
      } catch (dbErr) {
        logger.warn({ err: dbErr }, 'Failed to clear crashed session');
      }
      resultText = null;
      newSessionId = undefined;
    } else if (isExitCode1 && resultText) {
      logger.warn({ turns: turnCount }, 'CLI exited with code 1 after returning a result; using captured result');
    } else {
      logger.error({ err, turns: turnCount, tools: toolsUsed }, 'Agent execution failed');
      resultText = 'Something went wrong while processing your request.';
    }
  } finally {
    if (typingInterval) clearInterval(typingInterval);
  }

  return { text: resultText, newSessionId, toolsUsed, turnCount };
}
