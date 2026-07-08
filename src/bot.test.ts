import { describe, it, expect } from 'vitest';
import { formatForTelegram, splitMessage } from './bot.js';

describe('formatForTelegram', () => {
  it('should convert bold markdown', () => {
    expect(formatForTelegram('**hello**')).toBe('<b>hello</b>');
  });

  it('should convert italic markdown', () => {
    expect(formatForTelegram('*hello*')).toBe('<i>hello</i>');
  });

  it('should convert inline code', () => {
    expect(formatForTelegram('use `npm install`')).toBe('use <code>npm install</code>');
  });

  it('should convert code blocks', () => {
    const input = '```js\nconsole.log("hi")\n```';
    const result = formatForTelegram(input);
    expect(result).toContain('<pre>');
    expect(result).toContain('console.log');
  });

  it('should escape HTML in text', () => {
    const result = formatForTelegram('a < b & c > d');
    expect(result).toContain('&lt;');
    expect(result).toContain('&amp;');
    expect(result).toContain('&gt;');
  });

  it('should convert headings to bold', () => {
    expect(formatForTelegram('# Title')).toBe('<b>Title</b>');
  });

  it('should convert links', () => {
    expect(formatForTelegram('[click](https://example.com)')).toBe(
      '<a href="https://example.com">click</a>'
    );
  });

  it('should convert strikethrough', () => {
    expect(formatForTelegram('~~deleted~~')).toBe('<s>deleted</s>');
  });

  it('should convert checkboxes', () => {
    expect(formatForTelegram('- [ ] todo')).toContain('☐');
    expect(formatForTelegram('- [x] done')).toContain('☑');
  });
});

describe('splitMessage', () => {
  it('should not split short messages', () => {
    const chunks = splitMessage('hello', 4096);
    expect(chunks).toEqual(['hello']);
  });

  it('should split on newlines', () => {
    const long = 'a'.repeat(3000) + '\n' + 'b'.repeat(3000);
    const chunks = splitMessage(long, 4096);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it('should handle messages shorter than limit', () => {
    const chunks = splitMessage('short message');
    expect(chunks).toHaveLength(1);
  });
});
