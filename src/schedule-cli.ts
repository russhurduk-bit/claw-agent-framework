import { randomUUID } from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';
import { initDatabase, createTask, listTasks, deleteTask, setTaskStatus } from './db.js';
import { computeNextRun } from './scheduler.js';

function usage(): void {
  console.log(`
Usage:
  schedule-cli create "<prompt>" "<cron>" <chat_id>   Create a new scheduled task
  schedule-cli list                                     List all tasks
  schedule-cli delete <id>                              Delete a task
  schedule-cli pause <id>                               Pause a task
  schedule-cli resume <id>                              Resume a paused task

Examples:
  schedule-cli create "Summarize my emails" "0 9 * * *" 123456789
  schedule-cli create "Check server status" "*/30 * * * *" 123456789
`);
}

function main(): void {
  initDatabase();

  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    usage();
    process.exit(1);
  }

  switch (command) {
    case 'create': {
      const prompt = args[1];
      const cron = args[2];
      const chatId = args[3];

      if (!prompt || !cron || !chatId) {
        console.error('Error: create requires <prompt> <cron> <chat_id>');
        process.exit(1);
      }

      // Validate cron
      try {
        CronExpressionParser.parse(cron);
      } catch {
        console.error(`Error: Invalid cron expression "${cron}"`);
        process.exit(1);
      }

      const id = randomUUID().slice(0, 8);
      const nextRun = computeNextRun(cron);
      createTask(id, chatId, prompt, cron, nextRun);
      console.log(`✓ Task created: ${id}`);
      console.log(`  Prompt: ${prompt}`);
      console.log(`  Schedule: ${cron}`);
      console.log(`  Next run: ${new Date(nextRun * 1000).toLocaleString()}`);
      break;
    }

    case 'list': {
      const tasks = listTasks();
      if (tasks.length === 0) {
        console.log('No scheduled tasks.');
        break;
      }
      console.log(
        'ID       | Status  | Schedule        | Next Run                  | Prompt'
      );
      console.log('-'.repeat(95));
      for (const t of tasks) {
        const next = new Date(t.next_run * 1000).toLocaleString();
        const promptShort =
          t.prompt.length > 40 ? t.prompt.slice(0, 40) + '...' : t.prompt;
        console.log(
          `${t.id.padEnd(8)} | ${t.status.padEnd(7)} | ${t.schedule.padEnd(15)} | ${next.padEnd(25)} | ${promptShort}`
        );
      }
      break;
    }

    case 'delete': {
      const id = args[1];
      if (!id) {
        console.error('Error: delete requires <id>');
        process.exit(1);
      }
      if (deleteTask(id)) {
        console.log(`✓ Task ${id} deleted.`);
      } else {
        console.error(`Error: Task ${id} not found.`);
        process.exit(1);
      }
      break;
    }

    case 'pause': {
      const id = args[1];
      if (!id) {
        console.error('Error: pause requires <id>');
        process.exit(1);
      }
      if (setTaskStatus(id, 'paused')) {
        console.log(`✓ Task ${id} paused.`);
      } else {
        console.error(`Error: Task ${id} not found.`);
        process.exit(1);
      }
      break;
    }

    case 'resume': {
      const id = args[1];
      if (!id) {
        console.error('Error: resume requires <id>');
        process.exit(1);
      }
      if (setTaskStatus(id, 'active')) {
        console.log(`✓ Task ${id} resumed.`);
      } else {
        console.error(`Error: Task ${id} not found.`);
        process.exit(1);
      }
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      usage();
      process.exit(1);
  }
}

main();
