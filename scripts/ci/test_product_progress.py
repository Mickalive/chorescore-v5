import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('has-product-progress.py')


class RetryProgressTests(unittest.TestCase):
    def result(self, content):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, 'iterations.json').write_text(content)
            return subprocess.run([sys.executable, str(SCRIPT), directory], check=False).returncode

    def test_observed_three_read_only_passes_stop_the_retry_chain(self):
        self.assertEqual(self.result(json.dumps([
            {'attempt': n, 'productPaths': [], 'verifiedProductPatch': False} for n in [1, 2, 3]])), 1)

    def test_reports_alone_cannot_keep_the_writer_running(self):
        self.assertEqual(self.result(json.dumps([{'productPaths': ['VERIFICATION.md']} ])), 1)

    def test_actual_unfinished_source_is_eligible_for_another_repair_cycle(self):
        self.assertEqual(self.result(json.dumps([{'productPaths': ['src/feature.ts'], 'verifiedProductPatch': False}])), 0)

    def test_incomplete_metadata_does_not_request_another_cycle(self):
        self.assertEqual(self.result('[{"productPaths":'), 1)


if __name__ == '__main__':
    unittest.main()
