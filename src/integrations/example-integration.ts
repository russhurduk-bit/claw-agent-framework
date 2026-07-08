/**
 * Example integration: current weather.
 *
 * A minimal, dependency-free reference implementation of the Integration
 * contract (see ./index.ts). It shows the shape a real integration takes —
 * a matcher plus a handler that calls an external service and returns text.
 * Uses the public wttr.in service, so it needs no API key.
 *
 * Use this as a template for your own integrations (billing, smart home,
 * ticketing, etc.). Keep secrets in .env and read them via ../config.js.
 */

import type { Integration, IntegrationContext } from './index.js';
import { logger } from '../logger.js';

const TRIGGER = /^\s*(?:weather|forecast|погода)\b\s*(.*)$/i;

export const weatherIntegration: Integration = {
  id: 'weather',
  description: 'Current weather for a city ("weather London").',

  matches(ctx: IntegrationContext): boolean {
    return TRIGGER.test(ctx.text);
  },

  async handle(ctx: IntegrationContext): Promise<string> {
    const match = ctx.text.match(TRIGGER);
    const city = (match?.[1] || 'London').trim();

    try {
      const res = await fetch(
        `https://wttr.in/${encodeURIComponent(city)}?format=%l:+%C+%t,+wind+%w,+humidity+%h`,
        { signal: AbortSignal.timeout(10000) }
      );
      if (!res.ok) return `Could not fetch weather for "${city}".`;
      const line = (await res.text()).trim();
      return line || `No weather data for "${city}".`;
    } catch (err) {
      logger.warn({ err, city }, 'weather integration failed');
      return `Weather lookup failed for "${city}".`;
    }
  },
};
