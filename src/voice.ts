import { readFileSync, renameSync } from 'node:fs';
import { resolve, dirname, extname, basename } from 'node:path';
import OpenAI from 'openai';
import { createReadStream } from 'node:fs';
import { OPENAI_API_KEY, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID } from './config.js';
import { logger } from './logger.js';

// --- STT via OpenAI Whisper ---

export async function transcribeAudio(filePath: string): Promise<string> {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured');
  }

  // Rename .oga to .ogg (Telegram sends .oga, Whisper prefers .ogg)
  let actualPath = filePath;
  if (extname(filePath).toLowerCase() === '.oga') {
    actualPath = resolve(
      dirname(filePath),
      basename(filePath, '.oga') + '.ogg'
    );
    renameSync(filePath, actualPath);
  }

  const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
  const transcription = await openai.audio.transcriptions.create({
    model: 'whisper-1',
    file: createReadStream(actualPath),
  });

  logger.debug({ chars: transcription.text.length }, 'Audio transcribed');
  return transcription.text;
}

// --- TTS via ElevenLabs ---

export async function synthesizeSpeech(text: string): Promise<Buffer> {
  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
    throw new Error('ElevenLabs API key or voice ID is not configured');
  }

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'xi-api-key': ELEVENLABS_API_KEY,
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_turbo_v2_5',
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
      },
    }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`ElevenLabs TTS failed (${response.status}): ${errBody}`);
  }

  const arrayBuf = await response.arrayBuffer();
  logger.debug({ bytes: arrayBuf.byteLength }, 'Speech synthesized');
  return Buffer.from(arrayBuf);
}

// --- Capability check ---

export function voiceCapabilities(): { stt: boolean; tts: boolean } {
  return {
    stt: !!OPENAI_API_KEY,
    tts: !!(ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID),
  };
}
