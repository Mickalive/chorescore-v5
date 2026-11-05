import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('config_import', Path(__file__).with_name('import-android-config.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def fixture():
    return {'project_info': {'project_id': 'chorescore-a75b1'}, 'client': [{
        'client_info': {'android_client_info': {'package_name': 'app.chorescore.v5'}},
        'api_key': [{'current_key': 'public_test_key_1234567890'}],
        'oauth_client': [{'client_type': 1, 'client_id': 'android.apps.googleusercontent.com'},
                         {'client_type': 3, 'client_id': 'web.apps.googleusercontent.com'}]}]}


class PublicConfigImport(unittest.TestCase):
    def test_uses_web_oauth_and_preserves_unrelated_local_settings(self):
        values = module.extract(fixture())
        self.assertEqual(values['EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID'], 'web.apps.googleusercontent.com')
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / '.env.local'
            path.write_text('EXPO_PUBLIC_COLLAB_URL=https://example.org\nEXPO_PUBLIC_FIREBASE_API_KEY=old\n')
            module.write_environment(path, values)
            module.write_environment(path, values)
            self.assertIn('EXPO_PUBLIC_COLLAB_URL=https://example.org', path.read_text())
            self.assertEqual(path.read_text().count('EXPO_PUBLIC_FIREBASE_API_KEY='), 1)

    def test_rejects_private_keys_wrong_project_package_and_missing_web_client(self):
        cases = [{'type': 'service_account', 'private_key': 'must-not-be-imported'}]
        wrong_project = fixture(); wrong_project['project_info']['project_id'] = 'another'
        wrong_package = fixture(); wrong_package['client'][0]['client_info']['android_client_info']['package_name'] = 'another'
        missing_web = fixture(); missing_web['client'][0]['oauth_client'] = [{'client_type': 1}]
        for config in cases + [wrong_project, wrong_package, missing_web]:
            with self.subTest(config=config), self.assertRaises(ValueError):
                module.extract(config)


if __name__ == '__main__':
    unittest.main()
