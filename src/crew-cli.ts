#!/usr/bin/env node
/**
 * Crew CLI — manage the multi-agent system
 *
 * Usage:
 *   crew-cli daemon              — start orchestrator daemon (for systemd)
 *   crew-cli new "Client" "contact" "Title" "Description"
 *   crew-cli status [projectId]  — show project status or all projects
 *   crew-cli message <projectId> "text" — send client message
 *   crew-cli log [projectId]     — show activity log
 */

import { startOrchestrator, startProject, handleClientMessage, getProjectSummary, getActiveProjects } from './crew-orchestrator.js';
import { initCrewDb, getCrewLog } from './crew-db.js';

const args = process.argv.slice(2);
const command = args[0];

async function main() {
  switch (command) {
    case 'daemon': {
      console.log('Starting Crew Orchestrator daemon...');
      process.on('SIGTERM', () => { process.exit(0); });
      process.on('SIGINT', () => { process.exit(0); });
      await startOrchestrator();
      break;
    }

    case 'new': {
      initCrewDb();
      const [, clientName, contact, title, description] = args;
      if (!clientName || !title) {
        console.error('Usage: crew-cli new "Client Name" "contact" "Project Title" "Description"');
        process.exit(1);
      }
      const id = startProject(clientName, contact || '', title, description || '');
      console.log(`Project #${id} created. Manager will gather requirements.`);
      break;
    }

    case 'status': {
      initCrewDb();
      const projectId = args[1] ? parseInt(args[1]) : 0;
      if (projectId) {
        console.log(getProjectSummary(projectId));
      } else {
        console.log(getActiveProjects());
      }
      break;
    }

    case 'message': case 'msg': {
      initCrewDb();
      const pid = parseInt(args[1]);
      const text = args[2];
      if (!pid || !text) {
        console.error('Usage: crew-cli message <projectId> "text"');
        process.exit(1);
      }
      handleClientMessage(pid, text);
      console.log(`Message sent to project #${pid}`);
      break;
    }

    case 'log': {
      initCrewDb();
      const logPid = args[1] ? parseInt(args[1]) : undefined;
      const logs = getCrewLog(logPid, 20);
      for (const l of logs) {
        console.log(`[${l.createdAt}] ${l.agent}: ${l.action} — ${l.details.substring(0, 100)}`);
      }
      break;
    }

    default: {
      console.log(`Crew CLI — Multi-Agent System

Commands:
  daemon                                    Start orchestrator (background)
  new "Client" "contact" "Title" "Desc"     Create project
  status [projectId]                        Show status
  message <projectId> "text"                Client message
  log [projectId]                           Activity log`);
    }
  }
}

main().catch(err => {
  console.error('Crew CLI error:', err);
  process.exit(1);
});
