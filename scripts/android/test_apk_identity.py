"""Exercise the release gate against hostile signer/debug metadata."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('verify-apk-identity.sh')
CERTIFICATE = (SCRIPT.parent / 'fixtures' / 'development-certificate.pem').read_text()


class ApkIdentity(unittest.TestCase):
    def run_gate(self, badging, certificates):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            tools = root / 'build-tools' / '36.0.0'
            tools.mkdir(parents=True)
            for name, output in [('aapt', badging), ('apksigner', certificates)]:
                executable = tools / name
                executable.write_text('#!/usr/bin/env python3\nimport sys\nsys.stdout.write(' + repr(output) + ')\n')
                executable.chmod(0o755)
            env = {**os.environ, 'ANDROID_HOME': str(root)}
            env.pop('ANDROID_EXPECTED_SHA1', None)
            return subprocess.run(['bash', str(SCRIPT), str(root / 'candidate.apk')],
                                  env=env, capture_output=True, text=True)

    def test_single_signer_release_is_accepted_and_multiple_signers_rejected(self):
        badging = "package: name='app.chorescore.v5' versionCode='1' versionName='0.5.0'\n"
        certificates = 'Signer #1 certificate SHA-1 digest: abc\n' + CERTIFICATE
        self.assertEqual(self.run_gate(badging, certificates).returncode, 0)
        result = self.run_gate(badging, certificates + CERTIFICATE)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('found 2', result.stderr)

    def test_certificate_fingerprints_do_not_depend_on_build_tools_wording(self):
        result = self.run_gate("package: name='app.chorescore.v5'\n", 'Different human-readable labels\n'+CERTIFICATE)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('signer_sha1=5e8f16062ea3cd2c4a0d547876baa6f38cabf625', result.stdout)
        self.assertIn('signer_sha256=fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c', result.stdout)

    def test_large_debuggable_badging_cannot_escape_detection_via_sigpipe(self):
        badging = "package: name='app.chorescore.v5'\napplication-debuggable\n" + ('metadata\n' * 30000)
        result = self.run_gate(badging, 'Signer #1 certificate SHA-1 digest: abc\n')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('debuggable', result.stderr)


if __name__ == '__main__':
    unittest.main()
