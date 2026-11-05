"""Exercise the real controller's stopping behavior in a disposable Git repo.

Gate executables are fixtures here: this tests orchestration, not the product.
"""
import json
import os
from pathlib import Path
import runpy
import subprocess
import tempfile
import unittest
from unittest.mock import patch

CONTROLLER = Path(__file__).with_name('product-autopilot.py')


class MissionStopTests(unittest.TestCase):
    def exercise(self, gates_pass):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            previous = Path.cwd()
            try:
                os.chdir(root)
                (root / '.github').mkdir()
                (root / '.github/PRODUCT_AUTOPILOT.md').write_text('Repair the current failure.')
                subprocess.run(['git', 'init', '-q'], check=True)
                subprocess.run(['git', 'add', '.github'], check=True)
                subprocess.run(['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
                                'commit', '-qm', 'baseline'], check=True)
                original = subprocess.check_output(['git', 'rev-parse', 'HEAD'])
                tools = root / 'tools'
                tools.mkdir()
                for executable in ['npm', 'bash', 'python3']:
                    tool = tools / executable
                    tool.write_text('#!/bin/sh\nexit ' + ('1' if executable == 'npm' and not gates_pass else '0') + '\n')
                    tool.chmod(0o755)
                def idle_writer(args, log, timeout):
                    log.write_text('')
                    return False
                with patch.dict(os.environ, {'PATH': str(tools) + os.pathsep + os.environ['PATH'],
                                             'RUNNER_TEMP': str(root / 'runner'),
                                             'AUTOPILOT_MODEL': 'fixture-model'}), \
                     patch('worker_protocol.run_worker', side_effect=idle_writer) as writer:
                    with self.assertRaises(SystemExit) as stopped:
                        runpy.run_path(str(CONTROLLER), run_name='__main__')
                evidence = root / 'verification-evidence/autopilot'
                if gates_pass:
                    self.assertEqual(stopped.exception.code, 0)
                    writer.assert_not_called()
                    state = json.loads((evidence / 'mission-state.json').read_text())
                    self.assertTrue(state['automaticEditsStopped'])
                    self.assertFalse(state['fullProductComplete'])
                    self.assertEqual(state['status'], 'awaiting-final-acceptance')
                    self.assertFalse((evidence / 'verified.patch').exists())
                else:
                    self.assertEqual(writer.call_count, 3)
                    self.assertFalse((evidence / 'mission-state.json').exists())
                    self.assertIn('Baseline typecheck: FAIL', (root / '.opencode-ci/latest-checks.md').read_text())
                self.assertEqual(subprocess.check_output(['git', 'rev-parse', 'HEAD']), original)
                self.assertEqual(subprocess.check_output(['git', 'diff', 'HEAD']), b'')
            finally:
                os.chdir(previous)

    def test_all_green_stops_before_the_first_writer_call_without_claiming_full_completion(self):
        self.exercise(True)

    def test_actual_failure_remains_the_work_order_after_read_only_attempts(self):
        self.exercise(False)


if __name__ == '__main__':
    unittest.main()
