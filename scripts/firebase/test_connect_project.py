"""Exercise the manual Google setup's side effects without cloud credentials.
These are protocol/flow tests, not proof of deployment to a real Firebase project.
"""
import base64
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

spec = importlib.util.spec_from_file_location('connect_project', Path(__file__).with_name('connect-project.py'))
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


class FakeGoogle:
    def __init__(self, fresh=False, billing=False):
        self.calls = []
        self.fresh = fresh
        self.billing = billing
        self.ruleset = 'projects/chorescore-a75b1/rulesets/old'
        self.app = {'name': 'projects/chorescore-a75b1/androidApps/test-app', 'packageName': setup.PACKAGE}

    def operation(self, origin, response):
        return response['response']

    def call(self, method, url, body=None, allow_missing=False):
        self.calls.append((method, url, body))
        if url.endswith('/billingInfo'):
            return {'billingEnabled': self.billing}
        if url.endswith('/projects/chorescore-a75b1'):
            return {'projectId': setup.PROJECT, 'projectNumber': '123'}
        if '/services/' in url:
            return {'state': 'ENABLED'}
        if '/databases' in url:
            if method == 'POST':
                return {'done': True, 'response': {'type': 'FIRESTORE_NATIVE'}}
            return None if self.fresh else {'type': 'FIRESTORE_NATIVE'}
        if url.endswith('/androidApps?pageSize=100'):
            return {'apps': [] if self.fresh else [self.app]}
        if url.endswith('/androidApps') and method == 'POST':
            return {'done': True, 'response': self.app}
        if url.endswith('/sha'):
            if method == 'POST':
                return body
            manifest = json.loads((setup.ROOT / 'firebase/android-signing.json').read_text())
            return {'certificates': [] if self.fresh else [
                {'certType': 'SHA_1', 'shaHash': manifest['sha1']},
                {'certType': 'SHA_256', 'shaHash': manifest['sha256']},
            ]}
        if url.endswith('/defaultSupportedIdpConfigs/google.com'):
            return {'enabled': True, 'clientId': 'public-web.apps.googleusercontent.com', 'clientSecret': 'NEVER-EXPORT-THIS'}
        if url.endswith('/config'):
            data = {'project_info': {'project_id': setup.PROJECT}, 'client': [{
                'client_info': {'android_client_info': {'package_name': setup.PACKAGE}},
                'api_key': [{'current_key': 'PUBLIC-API-KEY'}],
            }]}
            return {'configFileContents': base64.b64encode(json.dumps(data).encode()).decode()}
        if url.endswith('/releases/cloud.firestore'):
            if method == 'PATCH':
                if set(body) != {'release'}:
                    raise AssertionError('Google Rules PATCH requires the documented release wrapper')
                self.ruleset = body['release']['rulesetName']
            if self.fresh and self.ruleset.endswith('/old'):
                return None
            return {'rulesetName': self.ruleset}
        if '/rulesets/' in url:
            return {'source': {'files': [{'name': 'firestore.rules', 'content': 'OLD PRIVATE RULES'}]}}
        if url.endswith('/rulesets') and method == 'POST':
            return {'name': 'projects/chorescore-a75b1/rulesets/new'}
        if url.endswith('/releases') and method == 'POST':
            self.ruleset = body['rulesetName']
            return body
        raise AssertionError((method, url, body))


class ManualSetup(unittest.TestCase):
    def test_real_http_error_preserves_service_reason_without_exporting_response(self):
        body = {'error': {'message': 'DO-NOT-PRINT-THIS', 'details': [{
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo', 'reason': 'SERVICE_DISABLED',
            'metadata': {'service': 'cloudbilling.googleapis.com'},
        }]}}
        error = urllib.error.HTTPError('https://cloudbilling.googleapis.com/v1/test', 403, 'Forbidden', {}, io.BytesIO(json.dumps(body).encode()))
        with patch('urllib.request.urlopen', side_effect=error):
            with self.assertRaises(setup.SetupError) as captured:
                setup.GoogleAPI('NEVER-PRINT-TOKEN').call('GET', 'https://cloudbilling.googleapis.com/v1/test')
        self.assertEqual(captured.exception.reason, 'SERVICE_DISABLED')
        self.assertEqual(captured.exception.service, 'cloudbilling.googleapis.com')
        self.assertNotIn('DO-NOT-PRINT-THIS', str(captured.exception))
        self.assertNotIn('NEVER-PRINT-TOKEN', str(captured.exception))

    def test_disabled_billing_read_api_is_enabled_then_billing_is_checked(self):
        api = FakeGoogle()
        original = api.call
        attempts = []
        def call(method, url, body=None, allow_missing=False):
            if url.endswith('/billingInfo'):
                attempts.append(url)
                if len(attempts) == 1:
                    raise setup.SetupError('API disabled', 403, 'SERVICE_DISABLED', 'cloudbilling.googleapis.com')
            if url.endswith('/services/cloudbilling.googleapis.com:enable'):
                api.calls.append((method, url, body))
                return {'done': True, 'response': {}}
            return original(method, url, body, allow_missing)
        api.call = call
        with tempfile.TemporaryDirectory() as folder, contextlib.redirect_stdout(io.StringIO()):
            setup.connect(api, apply=True, interactive=False, output=Path(folder))
        self.assertEqual(len(attempts), 2)
        self.assertEqual(len([url for method, url, _ in api.calls if method == 'POST' and 'cloudbilling' in url]), 1)
        self.assertFalse(any('billingAccounts' in url for _, url, _ in api.calls))

    def test_permission_denial_does_not_enable_services_or_bypass_billing(self):
        api = FakeGoogle()
        original = api.call
        def call(method, url, body=None, allow_missing=False):
            if url.endswith('/billingInfo'):
                raise setup.SetupError('Permission denied', 403, 'IAM_PERMISSION_DENIED', 'cloudbilling.googleapis.com')
            return original(method, url, body, allow_missing)
        api.call = call
        with self.assertRaisesRegex(setup.SetupError, 'Permission denied'):
            setup.connect(api, apply=True, interactive=False)
        self.assertTrue(all(method == 'GET' for method, _, _ in api.calls))

    def test_billing_enabled_refuses_every_write(self):
        api = FakeGoogle(billing=True)
        with self.assertRaisesRegex(setup.SetupError, 'facturation'):
            setup.connect(api, apply=True, interactive=False)
        self.assertTrue(all(call[0] == 'GET' for call in api.calls))
        self.assertEqual(len(api.calls), 2)

    def test_absent_billing_confirmation_refuses_every_write(self):
        api = FakeGoogle(billing=None)
        with self.assertRaises(setup.SetupError):
            setup.connect(api, apply=True, interactive=False)
        self.assertTrue(all(call[0] == 'GET' for call in api.calls))

    def test_read_only_existing_config_exports_no_credentials(self):
        api = FakeGoogle()
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            result = setup.connect(api, interactive=False)
        self.assertEqual(set(result), {'EXPO_PUBLIC_FIREBASE_PROJECT_ID', 'EXPO_PUBLIC_FIREBASE_API_KEY', 'EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID'})
        self.assertNotIn('NEVER-EXPORT-THIS', output.getvalue())
        self.assertTrue(all(call[0] == 'GET' for call in api.calls))

    def test_existing_database_keeps_data_and_backs_up_rules_before_publish(self):
        api = FakeGoogle()
        with tempfile.TemporaryDirectory() as folder, contextlib.redirect_stdout(io.StringIO()):
            output = Path(folder)
            setup.connect(api, apply=True, interactive=False, output=output)
            backups = list(output.glob('previous-firestore-rules-*.json'))
            self.assertEqual(len(backups), 1)
            self.assertIn('OLD PRIVATE RULES', backups[0].read_text())
            self.assertNotIn('NEVER-EXPORT-THIS', (output / 'chorescore-firebase-public.json').read_text())
        self.assertFalse(any(method != 'GET' and '/databases' in url for method, url, _ in api.calls))
        self.assertEqual(api.ruleset, 'projects/chorescore-a75b1/rulesets/new')

    def test_fresh_setup_creates_only_default_database_and_real_package(self):
        api = FakeGoogle(fresh=True)
        with tempfile.TemporaryDirectory() as folder, contextlib.redirect_stdout(io.StringIO()):
            setup.connect(api, apply=True, interactive=False, output=Path(folder))
        writes = [(url, body) for method, url, body in api.calls if method != 'GET']
        self.assertEqual(len([url for url, _ in writes if '/databases' in url]), 1)
        self.assertTrue(any('databaseId=%28default%29' in url and body['type'] == 'FIRESTORE_NATIVE' for url, body in writes))
        self.assertTrue(any(url.endswith('/androidApps') and body['packageName'] == setup.PACKAGE for url, body in writes))
        self.assertFalse(any(any(word in url for word in ['storage.googleapis', 'cloudfunctions', 'billingAccounts']) for url, _ in writes))


if __name__ == '__main__':
    unittest.main()
