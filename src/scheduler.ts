import { CronExpressionParser } from 'cron-parser';
import { getDueTasks, updateTaskAfterRun } from './db.js';
import { runAgent } from './agent.js';
import { logger } from './logger.js';

type Sender = (chatId: string, text: string) => Promise<void>;

let sender: Sender | undefined;
let pollInterval: ReturnType<typeof setInterval> | undefined;
// Guard against concurrent runs
let isRunning = false;

// Detect if a prompt is a simple reminder (no complex action needed)
const REMINDER_PATTERNS = [
  /^напомни\b/i,
  /^remind\b/i,
  /^не забудь\b/i,
  /^напоминание/i,
];

function isSimpleReminder(prompt: string): boolean {
  return REMINDER_PATTERNS.some((p) => p.test(prompt.trim()));
}

export function computeNextRun(cronExpression: string): number {
  const cron = CronExpressionParser.parse(cronExpression);
  return Math.floor(cron.next().toDate().getTime() / 1000);
}

export async function runDueTasks(): Promise<void> {
  // Prevent overlapping runs (if previous run is still going, skip)
  if (isRunning) {
    logger.warn('Skipping scheduler poll: previous run still in progress');
    return;
  }
  isRunning = true;

  try {
    const tasks = getDueTasks();
    if (tasks.length === 0) return;

    logger.info({ count: tasks.length }, 'Running due scheduled tasks');

    for (const task of tasks) {
      try {
        // Simple reminders: just send the text, no agent needed
        if (isSimpleReminder(task.prompt)) {
          const reminderText = task.prompt
            .replace(/^(напомни|remind|не забудь|напоминание)[:\s]*/i, '')
            .trim();

          if (sender) {
            await sender(task.chat_id, `⏰ ${reminderText || task.prompt}`);
          }

          const nextRun = computeNextRun(task.schedule);
          updateTaskAfterRun(task.id, nextRun, 'Reminder sent');
          logger.info({ taskId: task.id, nextRun }, 'Simple reminder sent');
          continue;
        }

        // Complex tasks: run through agent with strict guardrails

        const scheduledPrompt = [
          '[SYSTEM CONTEXT -- MANDATORY RULES FOR THIS EXECUTION]',
          'This is a SCHEDULED TASK being executed automatically by the scheduler.',
          `Task ID: ${task.id}`,
          '',
          'ABSOLUTE PROHIBITIONS for this execution:',
          '1. DO NOT create new scheduled tasks or reminders (no schedule-cli, no createTask).',
          '2. DO NOT send messages out of band. Your response text is delivered to the',
          '   user by the bot automatically -- that IS the delivery mechanism.',
          '3. Do not take irreversible actions (deletes, payments) without them being',
          '   explicitly part of the task prompt below.',
          '',
          'Just execute the task and return the result as text.',
          '[END SYSTEM CONTEXT]',
          '',
          task.prompt,
        ].join('\n');

        const result = await runAgent(scheduledPrompt);
        const responseText = result.text ?? '';

        // Silent tasks: do the work but don't spam the user
        const isSilent = task.prompt.includes('[SILENT]');

        // Send result directly without any prefix -- clean output
        // Skip sending for silent tasks (unless there's an error/issue to report)
        if (sender && responseText && !isSilent) {
          await sender(task.chat_id, responseText);
        }

        const nextRun = computeNextRun(task.schedule);
        updateTaskAfterRun(task.id, nextRun, responseText.slice(0, 1000));

        logger.info({ taskId: task.id, nextRun }, 'Scheduled task completed');
      } catch (err) {
        logger.error({ err, taskId: task.id }, 'Scheduled task failed');
        // Don't notify user about errors -- just log and move on
        const nextRun = computeNextRun(task.schedule);
        updateTaskAfterRun(task.id, nextRun, `ERROR: ${(err as Error).message}`);
      }
    }
  } finally {
    isRunning = false;
  }
}

export function initScheduler(send: Sender): void {
  sender = send;
  pollInterval = setInterval(() => {
    runDueTasks().catch((err) => {
      logger.error({ err }, 'Scheduler poll failed');
    });
  }, 60_000);

  // Run immediately on init
  runDueTasks().catch((err) => {
    logger.error({ err }, 'Initial scheduler poll failed');
  });

  logger.info('Scheduler initialized (polling every 60s)');
}

export function stopScheduler(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = undefined;
  }
}
