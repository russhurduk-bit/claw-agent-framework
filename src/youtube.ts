/**
 * YouTube enrichment: detect YouTube URLs in a message and fetch title +
 * transcript from a pluggable webhook (see YT_TRANSCRIPT_WEBHOOK), so the
 * agent can answer about a video without watching it. Degrades gracefully.
 */

import { logger } from './logger.js';

const YT_URL_RE = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/|live\/)|youtu\.be\/)([\w-]{11})(?:\S*)?/gi;
// Optional webhook that returns { title, channel, duration, transcript } for a YouTube URL.
// Point this at your own transcript service (e.g. an n8n workflow). Falls back gracefully.
const YT_WEBHOOK = process.env.YT_TRANSCRIPT_WEBHOOK ?? 'http://localhost:5678/webhook/youtube-transcript';

export function extractYoutubeUrls(text: string): string[] {
  const matches = [...text.matchAll(YT_URL_RE)];
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const m of matches) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      urls.push(m[0]);
    }
  }
  return urls;
}

export function extractVideoId(url: string): string | null {
  const m = url.match(/(?:watch\?v=|shorts\/|live\/|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : null;
}

interface VideoInfo {
  id: string;
  title: string;
  channel: string;
  duration: string;
  summary: string;
}

export async function fetchVideoInfo(url: string): Promise<VideoInfo | null> {
  const videoId = extractVideoId(url);
  if (!videoId) return null;

  logger.info({ videoId, url }, 'Fetching YouTube video via transcript webhook');

  try {
    const resp = await fetch(YT_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(60000),
    });

    if (!resp.ok) {
      logger.warn({ videoId, status: resp.status }, 'transcript webhook failed');
      return null;
    }

    const data = await resp.json() as any;

    const durSec = data.duration || 0;
    const durMin = Math.floor(durSec / 60);
    const durS = durSec % 60;
    const duration = `${durMin}:${String(durS).padStart(2, '0')}`;

    return {
      id: videoId,
      title: data.title || 'Unknown',
      channel: data.channel || 'Unknown',
      duration,
      summary: data.transcript || '',
    };
  } catch (e: any) {
    logger.warn({ videoId, err: e.message }, 'Failed to fetch YouTube video via webhook');
    return null;
  }
}

export function formatVideoContext(info: VideoInfo): string {
  const parts = [
    `[YouTube Video: "${info.title}"]`,
    `Channel: ${info.channel} | Duration: ${info.duration}`,
  ];

  if (info.summary) {
    // Truncate very long transcripts to keep context manageable
    const maxLen = 15000;
    let transcript = info.summary;
    if (transcript.length > maxLen) {
      transcript = transcript.substring(0, maxLen) + '\n\n[... transcript truncated, total ' + info.summary.length + ' chars]';
    }
    parts.push(`\nFull transcript:\n${transcript}`);
  } else {
    parts.push('\n(Could not get video transcript)');
  }

  return parts.join('\n');
}

export async function enrichMessageWithYouTube(text: string): Promise<string> {
  const urls = extractYoutubeUrls(text);
  if (urls.length === 0) return text;

  const contexts: string[] = [];
  for (const url of urls) {
    try {
      const info = await fetchVideoInfo(url);
      if (info) {
        contexts.push(formatVideoContext(info));
      }
    } catch (e: any) {
      logger.warn({ url, err: e.message }, 'Failed to process YouTube video');
      contexts.push(`[YouTube video ${url}: processing failed]`);
    }
  }

  if (contexts.length === 0) return text;

  return text + '\n\n' + contexts.join('\n\n');
}
