import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

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
  it('finds and taps real XML leaf controls instead of treating them as absent', () => {
    execFileSync('python3', [join(__dirname, '..', 'scripts', 'android', 'test_verify_device.py')], {
      timeout: 10_000,
      stdio: 'pipe',
    });
  });
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

  it('searches back towards the top when a control was scrolled past', () => {
    const find = functionBody('scroll_find');
    expect(find).toContain('scroll_top()');
  });

  it('dismisses the IME before rewinding the form to the top', () => {
    const top = functionBody('scroll_top');
    expect(top).toContain('hide_keyboard()');
    expect(top).toContain('swipe(False)');
  });

  it('drags the keyboard away inside the upper form band, never on Gboard', () => {
    const hide = functionBody('hide_keyboard');
    expect(hide).toContain("SWIPE_X,SWIPE_HIGH,SWIPE_X,SWIPE_LOW");
    expect(hide).toContain('keyboard_shown');
    expect(hide).not.toMatch(/'206',\s*'(470|500|520|610)'/);
  });

  it('keeps every scroll and dismiss drag above the tall IME band', () => {
    const swipe = functionBody('swipe');
    expect(source).toContain("SWIPE_HIGH = '320'");
    expect(source).toContain("SWIPE_LOW = '140'");
    expect(swipe).toContain('SWIPE_HIGH if up else SWIPE_LOW');
    expect(swipe).toContain('SWIPE_LOW if up else SWIPE_HIGH');
    expect(source).not.toMatch(/'206',\s*'(470|500|520|610)'/);
  });

  it('never taps a field hidden under a visible IME', () => {
    const find = functionBody('_scroll_find_pass');
    expect(find).toContain('find_visible');
    expect(find).toContain('keyboard_shown()');
    expect(find).toContain('hide_keyboard()');
    const top = functionBody('ime_top');
    expect(top).toContain('InputMethod');
    expect(top).toContain('frame');
    const visible = functionBody('find_visible');
    expect(visible).toContain('usable_bottom()');
    expect(visible).toContain('onscreen');
  });

  it('opens each reminder dialog deterministically without arbitrary sleeps', () => {
    expect(source).toContain("open_datetime('todos.reminderDateTime')");
    expect(source).not.toContain("scroll_to(resource='todos.reminderDateTime')");
    expect(source).not.toContain("locate(resource='todos.reminderDateTime.date'");
    const open = functionBody('open_datetime');
    expect(open).toContain("resource+'.date'");
    expect(open).toContain('for attempt in range(2)');
  });

  it('matches category chips exposed as raw resource names, not only prefixed ids', () => {
    const chip = functionBody('category_chip');
    const name = functionBody('resource_name');
    expect(name).toContain("split('/')[-1]");
    expect(chip).toContain("startswith('add.category.')");
    expect(chip).toContain("rid != 'add.category.none'");
    expect(chip).not.toContain("'/add.category.' in");
  });

  it('finds category chips whose label is only in content-desc', () => {
    const chip = functionBody('category_chip');
    expect(chip).toContain("node.attrib.get('content-desc','')");
    expect(chip).toMatch(/name in label/);
  });

  it('taps the real document row and not the DocumentsUI preview overlay', () => {
    const picker = functionBody('picker_file_node');
    const select = functionBody('select_photo');
    expect(picker).toContain('startswith(name)');
    expect(picker).toContain("'preview' in value.lower()");
    expect(select).toContain('picker_file_node(PHOTO_NAME)');
    expect(select).not.toContain("label='chorescore-photo'");
    expect(select).toContain("resource='dir_list'");
  });

  it('waits for the app and the attached-photo chip after picking', () => {
    const select = functionBody('select_photo');
    expect(select).toContain('foreground_packages');
    expect(select).toContain("label='Photo jointe'");
    expect(select).toContain('add.taskPhotoButton');
    expect(select).not.toContain('Some builds might use different text');
  });

  it('scrolls every expanded category control into view instead of tapping blindly', () => {
    for (const resource of [
      'add.categoryDraftRatioToggle',
      'add.categoryCreateButton',
    ]) {
      expect(source).toContain(`scroll_to(resource='${resource}')`);
      expect(source).not.toContain(`tap('${resource}')`);
    }
  });

  it('only feeds ASCII to adb input text and fails loudly otherwise', () => {
    const input = functionBody('input_text');
    expect(input).toContain('isascii()');
    expect(input).toContain('AssertionError');
    expect(source).not.toContain("fill('todos.createTitle','Todo tâche CI')");
    expect(source).not.toContain("fill('todos.createTitle','Todo dépense CI')");
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
