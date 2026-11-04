"""The acceptance gate must reject stale, partial and mismatched APK evidence."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('journey', Path(__file__).with_name('run-journey.py'))
journey = importlib.util.module_from_spec(spec)
spec.loader.exec_module(journey)


class EvidenceGate(unittest.TestCase):
    def test_rejects_partial_success_and_evidence_from_another_apk(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            apk = directory / 'app.apk'
            apk.write_bytes(b'candidate')
            result = directory / 'result.json'
            result.write_text(json.dumps({'status': 'passed', 'apk_sha256': 'old-apk'}))
            with self.assertRaisesRegex(ValueError, 'does not match'):
                journey.validate_evidence(directory, apk)
            result.write_text(json.dumps({'status': 'passed',
                'apk_sha256': hashlib.sha256(apk.read_bytes()).hexdigest()}))
            with self.assertRaisesRegex(ValueError, 'screenshot'):
                journey.validate_evidence(directory, apk)
            for name in journey.REQUIRED_CAPTURES:
                (directory / (name + '.png')).write_bytes(b'\x89PNG\r\n\x1a\nfixture')
                (directory / (name + '.xml')).write_text('<hierarchy/>')
            self.assertEqual(journey.validate_evidence(directory, apk)['status'], 'passed')
            (directory / (journey.REQUIRED_CAPTURES[-1] + '.xml')).unlink()
            with self.assertRaisesRegex(ValueError, 'hierarchy'):
                journey.validate_evidence(directory, apk)

    def test_failed_report_cannot_be_accepted_with_valid_digest(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            apk = directory / 'app.apk'
            apk.write_bytes(b'candidate')
            (directory / 'result.json').write_text(json.dumps({'status': 'failed',
                'apk_sha256': hashlib.sha256(apk.read_bytes()).hexdigest()}))
            with self.assertRaisesRegex(ValueError, 'did not pass'):
                journey.validate_evidence(directory, apk)


if __name__ == '__main__':
    unittest.main()
