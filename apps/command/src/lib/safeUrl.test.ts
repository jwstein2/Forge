import { safeHref } from './safeUrl';

describe('safeHref (QA-001 D7)', () => {
  it('allows https only', () => {
    expect(safeHref('https://dash.cloudflare.com/')).toBe('https://dash.cloudflare.com/');
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref(' JavaScript:alert(1)')).toBeNull();
    expect(safeHref('data:text/html,hi')).toBeNull();
    expect(safeHref('http://example.com')).toBeNull();
    expect(safeHref('')).toBeNull();
    expect(safeHref(null)).toBeNull();
  });
  it('vault links accept only 1Password', () => {
    expect(safeHref('https://start.1password.com/open/i?a=A&v=V&i=I', { vault: true })).toContain('1password.com');
    expect(safeHref('onepassword://open/i?i=I', { vault: true })).toBe('onepassword://open/i?i=I');
    expect(safeHref('https://evil.example/1password.com', { vault: true })).toBeNull();
    expect(safeHref('javascript:alert(1)', { vault: true })).toBeNull();
  });
});
