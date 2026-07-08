import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const envPath = resolve(PROJECT_ROOT, '.env');

describe('readEnvFile', () => {
  let originalEnv: string | null = null;

  beforeEach(async () => {
    try {
      const { readFileSync } = await import('node:fs');
      originalEnv = readFileSync(envPath, 'utf-8');
    } catch {
      originalEnv = null;
    }
  });

  afterEach(() => {
    if (originalEnv !== null) {
      writeFileSync(envPath, originalEnv);
    } else {
      try {
        unlinkSync(envPath);
      } catch { /* noop */ }
    }
  });

  it('should parse simple KEY=VALUE pairs', async () => {
    writeFileSync(envPath, 'FOO=bar\nBAZ=123\n');
    // Dynamic import to pick up the fresh .env
    const { readEnvFile } = await import('./env.js');
    const result = readEnvFile();
    expect(result['FOO']).toBe('bar');
    expect(result['BAZ']).toBe('123');
  });

  it('should handle quoted values', async () => {
    writeFileSync(envPath, 'KEY1="hello world"\nKEY2=\'single quoted\'\n');
    const { readEnvFile } = await import('./env.js');
    const result = readEnvFile();
    expect(result['KEY1']).toBe('hello world');
    expect(result['KEY2']).toBe('single quoted');
  });

  it('should skip comments and empty lines', async () => {
    writeFileSync(envPath, '# comment\n\nKEY=val\n# another comment\n');
    const { readEnvFile } = await import('./env.js');
    const result = readEnvFile();
    expect(Object.keys(result)).toHaveLength(1);
    expect(result['KEY']).toBe('val');
  });

  it('should return empty object when .env missing', async () => {
    try { unlinkSync(envPath); } catch { /* noop */ }
    const { readEnvFile } = await import('./env.js');
    const result = readEnvFile();
    expect(result).toEqual({});
  });

  it('should filter by keys when provided', async () => {
    writeFileSync(envPath, 'A=1\nB=2\nC=3\n');
    const { readEnvFile } = await import('./env.js');
    const result = readEnvFile(['A', 'C']);
    expect(result['A']).toBe('1');
    expect(result['C']).toBe('3');
    expect(result['B']).toBeUndefined();
  });
});
