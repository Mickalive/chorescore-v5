import unittest
import json
from pathlib import Path
import sys
import tempfile
import time
from worker_protocol import WorkerProgress, run_worker, is_verified_product_patch


def event(tool, status='error'):
    return {'type': 'tool_use', 'part': {'tool': tool, 'state': {'status': status, 'error': 'invalid arguments'}}}


class ProgressTests(unittest.TestCase):
    def test_only_all_independent_product_gates_authorize_retaining_a_patch(self):
        checks = [{'check': name, 'passed': True} for name in
                  ['typecheck', 'application', 'backend', 'firestore', 'browser', 'android']]
        self.assertTrue(is_verified_product_patch(['src/feature.ts'], checks))
        self.assertFalse(is_verified_product_patch([], checks))
        self.assertFalse(is_verified_product_patch(['src/feature.ts'], checks[:-1]))
        failed = [*checks[:-1], {'check': 'android', 'passed': False}]
        self.assertFalse(is_verified_product_patch(['src/feature.ts'], failed))
        repeated = [*checks[:-1], checks[0]]
        self.assertFalse(is_verified_product_patch(['src/feature.ts'], repeated))

    def test_verified_files_stop_a_stalled_probe_without_trusting_its_claim(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder)/'candidate.txt'
            command = ('from pathlib import Path; import time; '
                'p=Path('+repr(str(target))+'); p.write_text("correct"); '
                'print('+repr(json.dumps(event('edit', 'completed')))+',flush=True); time.sleep(30)')
            start = time.monotonic()
            self.assertTrue(run_worker([sys.executable, '-c', command], Path(folder)/'worker.log', 10,
                verified_when=lambda e: target.read_text() == 'correct'))
            self.assertLess(time.monotonic()-start, 5)

    def test_false_claim_cannot_override_the_acceptance_callback(self):
        with tempfile.TemporaryDirectory() as folder:
            command = 'import time; print('+repr(json.dumps(event('edit', 'completed')))+',flush=True); time.sleep(30)'
            self.assertFalse(run_worker([sys.executable, '-c', command], Path(folder)/'worker.log', .2,
                verified_when=lambda e: False))

    def test_normal_successful_process_is_not_killed(self):
        with tempfile.TemporaryDirectory() as folder:
            self.assertTrue(run_worker([sys.executable,'-c','print("done")'],Path(folder)/'worker.log',5))

    def test_real_stalled_process_is_stopped_before_its_sleep_finishes(self):
        with tempfile.TemporaryDirectory() as folder:
            log=Path(folder)/'worker.log'
            command='import time; print('+repr(json.dumps(event('task')))+',flush=True); time.sleep(30)'
            start=time.monotonic()
            self.assertFalse(run_worker([sys.executable,'-c',command],log,10))
            self.assertLess(time.monotonic()-start,5)
            self.assertIn('Delegation is forbidden',log.read_text())

    def test_the_observed_invalid_delegation_stops_immediately(self):
        self.assertIn('Delegation', WorkerProgress().accept(event('task')))

    def test_three_errors_stop_but_a_success_resets_the_streak(self):
        p = WorkerProgress()
        self.assertIsNone(p.accept(event('read')))
        self.assertIsNone(p.accept(event('read')))
        self.assertIsNone(p.accept(event('read', 'completed')))
        self.assertIsNone(p.accept(event('edit')))
        self.assertIsNone(p.accept(event('edit')))
        self.assertIn('Three consecutive', p.accept(event('edit')))

    def test_only_successful_edits_count(self):
        p = WorkerProgress()
        p.accept(event('read', 'completed'))
        p.accept(event('edit'))
        self.assertEqual(p.edits, 0)
        p.accept(event('edit', 'completed'))
        self.assertEqual(p.edits, 1)


if __name__ == '__main__':
    unittest.main()
