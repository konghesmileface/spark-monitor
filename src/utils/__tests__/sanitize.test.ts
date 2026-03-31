import { describe, it, expect } from 'vitest';
import { escapeHtml, sanitizeUrl, escapeAttr } from '../sanitize';

describe('escapeHtml', () => {
  it('escapes all HTML special chars', () => {
    expect(escapeHtml('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('returns empty string for falsy input', () => {
    expect(escapeHtml('')).toBe('');
    // @ts-expect-error testing runtime safety
    expect(escapeHtml(null)).toBe('');
    // @ts-expect-error testing runtime safety
    expect(escapeHtml(undefined)).toBe('');
  });

  it('leaves safe strings unchanged', () => {
    expect(escapeHtml('hello world 123')).toBe('hello world 123');
  });

  it('handles XSS payloads', () => {
    const xss = '<script>alert("xss")</script>';
    const escaped = escapeHtml(xss);
    expect(escaped).not.toContain('<script>');
    expect(escaped).toContain('&lt;script&gt;');
  });
});

describe('sanitizeUrl', () => {
  it('allows http URLs', () => {
    const result = sanitizeUrl('http://example.com');
    expect(result).toContain('example.com');
  });

  it('allows https URLs', () => {
    const result = sanitizeUrl('https://example.com/path?q=1');
    expect(result).toContain('example.com');
  });

  it('blocks javascript: protocol', () => {
    expect(sanitizeUrl('javascript:alert(1)')).toBe('');
  });

  it('blocks data: protocol', () => {
    expect(sanitizeUrl('data:text/html,<h1>hi</h1>')).toBe('');
  });

  it('allows relative paths', () => {
    expect(sanitizeUrl('/path/to/page')).toBeTruthy();
    expect(sanitizeUrl('./relative')).toBeTruthy();
    expect(sanitizeUrl('../parent')).toBeTruthy();
  });

  it('blocks bare strings that look like protocol injection', () => {
    expect(sanitizeUrl('vbscript:foo')).toBe('');
  });

  it('returns empty for empty input', () => {
    expect(sanitizeUrl('')).toBe('');
    // @ts-expect-error testing runtime safety
    expect(sanitizeUrl(null)).toBe('');
  });

  it('escapes HTML entities in output', () => {
    const result = sanitizeUrl('https://example.com/page?a=1&b=2');
    expect(result).toContain('&amp;');
  });
});

describe('escapeAttr', () => {
  it('escapes attribute values', () => {
    expect(escapeAttr('" onmouseover="alert(1)"')).toBe('&quot; onmouseover=&quot;alert(1)&quot;');
  });
});
