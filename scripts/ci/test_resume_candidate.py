import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from resume_candidate import restore_candidate


class CandidateRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.previous = Path.cwd()
        os.chdir(self.folder.name)
        self.addCleanup(self.cleanup)
        self.git('init', '-q')
        self.git('config', 'user.name', 'Test')
        self.git('config', 'user.email', 'test@example.invalid')
        Path('src').mkdir()
        Path('src/feature.ts').write_text('old\n')
        Path('control.py').write_text('protected\n')
        self.git('add', '.')
        self.git('commit', '-qm', 'baseline')
        self.base = self.git('rev-parse', 'HEAD').decode().strip()
        self.evidence = Path('evidence')
        self.evidence.mkdir()
        (self.evidence / 'base.txt').write_text(self.base)

    def cleanup(self):
        os.chdir(self.previous)
        self.folder.cleanup()

    def git(self, *args):
        return subprocess.check_output(['git', *args], stderr=subprocess.DEVNULL)

    def candidate(self, path='src/feature.ts'):
        Path(path).write_text('actual unfinished repair\n')
        (self.evidence / 'candidate-1.patch').write_bytes(self.git('diff', '--binary'))
        (self.evidence / 'iterations.json').write_text(json.dumps([
            {'attempt': 1, 'productPaths': [path], 'verifiedProductPatch': False}]))
        self.git('restore', '.')

    def restore(self, base=None):
        return restore_candidate(self.evidence, base or self.base,
                                 lambda path: path == 'src/feature.ts')

    def test_real_unfinished_patch_is_restored_but_never_declared_verified(self):
        self.candidate()
        result = self.restore()
        self.assertFalse(result['verified'])
        self.assertEqual(Path('src/feature.ts').read_text(), 'actual unfinished repair\n')
        self.assertEqual(self.git('diff', '--cached', '--name-only').decode().strip(), 'src/feature.ts')

    def test_new_upstream_revision_refuses_the_old_candidate(self):
        self.candidate()
        self.git('commit', '--allow-empty', '-qm', 'upstream advanced')
        self.assertIsNone(self.restore(self.git('rev-parse', 'HEAD').decode().strip()))
        self.assertEqual(Path('src/feature.ts').read_text(), 'old\n')

    def test_protected_control_change_is_rejected_before_apply(self):
        self.candidate('control.py')
        self.assertIsNone(self.restore())
        self.assertEqual(Path('control.py').read_text(), 'protected\n')
        self.assertEqual(self.git('diff', '--cached'), b'')

    def test_broken_candidate_does_not_destroy_the_baseline(self):
        self.candidate()
        (self.evidence / 'candidate-1.patch').write_text('not a patch')
        self.assertIsNone(self.restore())
        self.assertEqual(Path('src/feature.ts').read_text(), 'old\n')

    def test_interrupted_metadata_write_does_not_break_the_next_audit(self):
        self.candidate()
        (self.evidence / 'iterations.json').write_text('[{"attempt":')
        self.assertIsNone(self.restore())
        self.assertEqual(Path('src/feature.ts').read_text(), 'old\n')

    def test_symlink_patch_cannot_replace_an_allowed_source_file(self):
        Path('src/feature.ts').unlink()
        Path('src/feature.ts').symlink_to('../control.py')
        (self.evidence / 'candidate-1.patch').write_bytes(self.git('diff', '--binary'))
        (self.evidence / 'iterations.json').write_text(json.dumps([
            {'attempt': 1, 'productPaths': ['src/feature.ts']}]))
        self.git('restore', '.')
        self.assertIsNone(self.restore())
        self.assertFalse(Path('src/feature.ts').is_symlink())
        self.assertEqual(Path('control.py').read_text(), 'protected\n')


if __name__ == '__main__':
    unittest.main()
