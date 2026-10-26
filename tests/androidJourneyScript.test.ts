import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(
  join(__dirname, '..', 'scripts', 'android', 'verify-device.py'),
  'utf8',
);

function functionBody(name: string): string {
  const start = source.indexOf(`def ${name}(`);
  if (start === -1) throw new Error(`Missing ${name}`);
  const next = source.indexOf('\ndef ', start + 1);
  return source.slice(start, next === -1 ? undefined : next).replace(/"""[\s\S]*?"""/g, '');
}

describe('Android journey driver', () => {
  it('never dismisses the keyboard with BACK or ESCAPE', () => {
    const hide = functionBody('hide_keyboard');
    expect(hide).not.toMatch(/KEYCODE_(BACK|ESCAPE)/);
    expect(hide).toMatch(/keyboard_shown/);
    expect(hide).toMatch(/input',\s*'swipe'/);
  });

  it('checks the real IME window instead of stale focus flags', () => {
    const shown = functionBody('keyboard_shown');
    expect(shown).toContain('mViewVisibility');
    expect(shown).not.toMatch(/mCurrentFocus/);
    expect(shown).not.toMatch(/mInputShown/);
  });

  it('keeps the full native journey assertions', () => {
    for (const marker of [
      'add_member_at_creation',
      'select_photo',
      'wait_for_permission',
      'wait_for_reminder',
      'double_tap',
      'todos.completeSubmit',
      'balances.deleteEntry',
      'ChooserActivity',
    ]) {
      expect(source).toContain(marker);
    }
    expect(source).toContain("raise AssertionError(\n            f'App left foreground during {context}");
  });
});
