"""Exercise real journey selectors against UIAutomator XML without a device."""
import ast
from pathlib import Path
import re
import unittest
import time
from unittest.mock import Mock
from types import SimpleNamespace
import xml.etree.ElementTree as ET


def driver():
    # Load production functions without executing the install-and-run journey.
    source = Path(__file__).with_name('verify-device.py').read_text()
    module = ast.parse(source)
    functions = ast.Module(
        body=[node for node in module.body if isinstance(node, ast.FunctionDef)],
        type_ignores=[],
    )
    env = {'re': re, 'ET': ET}
    exec(compile(functions, 'verify-device.py', 'exec'), env)
    env['real_keyboard_shown'] = env['keyboard_shown']
    env['real_scroll_top'] = env['scroll_top']
    env.update(
        hierarchy=Mock(), screen_size=lambda: (412, 915),
        usable_bottom=lambda: 900, swipe=Mock(), scroll_top=Mock(),
        tap_node=Mock(), keyboard_shown=lambda: False,
        dismiss_system_dialog=lambda _: False, dismiss_permission=lambda _: False,
    )
    return env


class SelectorBehavior(unittest.TestCase):
    def test_a_todo_title_behind_the_shade_is_not_notification_evidence(self):
        env = driver()
        root = ET.fromstring('<hierarchy><node package="app.chorescore.v5" text="Rappel CI" bounds="[10,100][300,150]"/>'
                             '<node package="com.android.systemui" text="21:30" bounds="[10,0][50,25]"/></hierarchy>')
        self.assertFalse(env['notification_visible'](root,'Rappel CI'))

    def test_notification_shade_accepts_a_real_remote_view_title(self):
        env = driver()
        root = ET.fromstring('<hierarchy><node package="com.android.systemui" resource-id="com.android.systemui:id/notification_stack_scroller" bounds="[0,0][412,900]">'
                             '<node package="app.chorescore.v5" text="Rappel : Rappel CI" bounds="[20,100][390,150]"/></node></hierarchy>')
        self.assertTrue(env['notification_visible'](root,'Rappel CI'))


    def test_localized_money_matches_only_the_exact_amount_ignoring_currency_spacing(self):
        env = driver()
        root = ET.fromstring('<hierarchy><node text="+ 1,84&#8239;CHF" '
                             'bounds="[18,120][390,170]"/></hierarchy>')
        env['hierarchy'].return_value = root
        self.assertIs(env['scroll_find']('+ 1,84 CHF'), root[0])
        self.assertEqual(env['candidates'](root, label='+ 1,85 CHF'), [])

    def test_filling_a_prefilled_time_replaces_it_instead_of_appending(self):
        env = driver()
        root = ET.fromstring('<hierarchy><node resource-id="reminder.time" text="12:34" '
                             'focused="true" bounds="[18,120][390,170]"/></hierarchy>')
        field = root[0]
        selected = False
        def adb(*args):
            nonlocal selected
            if args[2:]==('keycombination','113','29'):
                selected=True
            elif args[2:]==('keyevent','KEYCODE_DEL'):
                field.set('text','' if selected else field.attrib['text'][:-1])
                selected=False
            elif args[2]=='text':
                field.set('text',(field.attrib['text']+args[3].replace('%s',' '))[:5])
            return ''
        env.update(adb=adb,time=time,hide_keyboard=Mock())
        env['hierarchy'].return_value=root
        env['fill_node'](field,'08:17')
        self.assertEqual(field.attrib['text'],'08:17')

    def test_rewinding_stops_when_the_viewport_reaches_the_top(self):
        env = driver()
        scrolled = ET.fromstring('<hierarchy><node text="Notes" bounds="[18,120][390,170]"/></hierarchy>')
        top = ET.fromstring('<hierarchy><node text="Titre" bounds="[18,120][390,170]"/></hierarchy>')
        env['hierarchy'].side_effect = [scrolled, top, top]
        env['hide_keyboard'] = Mock()
        env['real_scroll_top']()
        self.assertEqual(env['swipe'].call_count, 2)
        env['hide_keyboard'].assert_called_once()

    def test_visible_leaf_field_is_found_without_scrolling(self):
        env = driver()
        root = ET.fromstring('<hierarchy><node resource-id="todos.createTitle" '
                             'enabled="true" bounds="[18,120][390,170]"/></hierarchy>')
        env['hierarchy'].return_value = root
        result = env['scroll_find'](resource='todos.createTitle')
        self.assertIs(result, root[0])
        env['swipe'].assert_not_called()
        env['scroll_top'].assert_not_called()

    def test_leaf_field_is_found_after_rewinding(self):
        env = driver()
        empty = ET.fromstring('<hierarchy/>')
        root = ET.fromstring('<hierarchy><node resource-id="add.taskValue" '
                             'bounds="[18,120][390,170]"/></hierarchy>')
        env['hierarchy'].side_effect = [empty] * 12 + [root]
        self.assertIs(env['scroll_find'](resource='add.taskValue'), root[0])
        env['scroll_top'].assert_called_once()

    def test_leaf_category_with_accessibility_label_is_tapped(self):
        for prefix in ('', 'app.chorescore.v5:id/'):
            with self.subTest(prefix=prefix):
                env = driver()
                root = ET.fromstring('<hierarchy><node resource-id="' + prefix +
                                     'add.category.c1" content-desc="Menage CI" '
                                     'bounds="[18,120][120,170]"/></hierarchy>')
                env['hierarchy'].return_value = root
                env['tap_category']('Menage CI')
                env['tap_node'].assert_called_once_with(root[0])
                env['swipe'].assert_not_called()

    def test_absent_field_still_fails(self):
        env = driver()
        env['hierarchy'].return_value = ET.fromstring('<hierarchy/>')
        with self.assertRaisesRegex(AssertionError, 'Control absent'):
            env['scroll_find'](resource='missing')

    def test_failed_launch_is_bounded_and_reports_failure(self):
        env = driver()
        env.update(adb=Mock(return_value=''), PACKAGE='app.chorescore.v5',
                   time=SimpleNamespace(sleep=Mock()))
        env['hierarchy'].return_value = ET.fromstring('<hierarchy/>')
        with self.assertRaisesRegex(AssertionError, 'Groups screen did not open'):
            env['start']()
        self.assertEqual(env['hierarchy'].call_count, 20)
        env['adb'].assert_called_once()

    def test_app_mentioning_input_method_is_not_treated_as_a_keyboard(self):
        env = driver()
        env['adb'] = Mock(return_value='''
  Window #0 Window{app u0 app.chorescore.v5/.MainActivity}:
    mIsImWindow=false mViewVisibility=0x0 mHasSurface=true
    mFrame=[0,24][412,915]
    mInputMethodWindow=Window{ime u0 InputMethod}
''')
        self.assertFalse(env['real_keyboard_shown']())
        self.assertIsNone(env['ime_top']())

    def test_visible_keyboard_uses_its_own_frame_not_the_apps_or_parent_frame(self):
        env = driver()
        env['adb'] = Mock(return_value='''
  Window #0 Window{app u0 app.chorescore.v5/.MainActivity}:
    mIsImWindow=false mViewVisibility=0x0 mHasSurface=true
    mFrame=[0,24][412,915]
    mInputMethodWindow=Window{ime u0 InputMethod}
  Window #1 Window{ime u0 InputMethod}:
    mIsImWindow=true mViewVisibility=0x0 mHasSurface=true
    mParentFrame=[0,0][412,915]
    mFrame=[0,583][412,915]
''')
        self.assertTrue(env['real_keyboard_shown']())
        self.assertEqual(env['ime_top'](), 583)


if __name__ == '__main__':
    unittest.main()
