/**
 * Pluggable integrations.
 *
 * An Integration is a self-contained module that teaches the assistant to talk
 * to an external service (a bank, a smart-home hub, a school portal, a CRM, ...).
 * The private integrations that shipped with the author's personal instance were
 * removed for this public release; this file documents the contract they
 * implemented and ships one generic example (see example-integration.ts).
 *
 * Two ways to wire an integration in:
 *  1. As a CLI the agent calls via Bash (the loosest coupling — the agent decides
 *     when to invoke it, guided by a skill file in .claude/skills/).
 *  2. As a matcher registered here, handled before the message reaches the agent
 *     (for deterministic, low-latency commands).
 */

export interface IntegrationContext {
  chatId: string;
  text: string;
}

export interface Integration {
  /** Stable identifier, e.g. "weather". */
  id: string;
  /** One-line human description shown in help/registry listings. */
  description: string;
  /** Return true if this integration should handle the message. */
  matches(ctx: IntegrationContext): boolean;
  /** Handle the message and return a reply string. */
  handle(ctx: IntegrationContext): Promise<string>;
}

import { weatherIntegration } from './example-integration.js';

/** Registry of active integrations. Add your own here. */
export const INTEGRATIONS: Integration[] = [
  weatherIntegration,
];

/**
 * Find the first integration that wants to handle a message.
 * Returns undefined so the caller can fall back to the LLM agent.
 */
export function matchIntegration(ctx: IntegrationContext): Integration | undefined {
  return INTEGRATIONS.find((i) => {
    try {
      return i.matches(ctx);
    } catch {
      return false;
    }
  });
}
