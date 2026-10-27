"""Exercise real journey selectors against UIAutomator XML without a device."""
import ast
from pathlib import Path
import re
import unittest
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
    env = {'re': re}
    exec(compile(functions, 'verify-device.py', 'exec'), env)
    env.update(
        hierarchy=Mock(), screen_size=lambda: (412, 915),
        usable_bottom=lambda: 900, swipe=Mock(), scroll_top=Mock(),
        tap_node=Mock(), keyboard_shown=lambda: False,
        dismiss_system_dialog=lambda _: False, dismiss_permission=lambda _: False,
    )
    return env


class SelectorBehavior(unittest.TestCase):
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


if __name__ == '__main__':
    unittest.main()
