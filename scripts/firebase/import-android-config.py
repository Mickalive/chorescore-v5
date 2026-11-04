"""Validate public Firebase Android configuration; no login or network access.

Run by the maintainer after receiving google-services.json, not by the owner.
Never accepts service account credentials or changes production Firebase.
"""
import argparse
import json
from pathlib import Path
import re

PROJECT = 'chorescore-a75b1'
PACKAGE = 'app.chorescore.v5'


def extract(config):
    if not isinstance(config, dict) or 'private_key' in config or config.get('type') == 'service_account':
        raise ValueError('Expected public google-services.json, never a service account key')
    if config.get('project_info', {}).get('project_id') != PROJECT:
        raise ValueError('Configuration belongs to another Firebase project')
    clients = [client for client in config.get('client', [])
        if client.get('client_info', {}).get('android_client_info', {}).get('package_name') == PACKAGE]
    if len(clients) != 1:
        raise ValueError('Expected exactly one app.chorescore.v5 Android client')
    client = clients[0]
    keys = [item.get('current_key', '') for item in client.get('api_key', [])]
    if not keys or not re.fullmatch(r'[A-Za-z0-9_-]{20,200}', keys[0]):
        raise ValueError('Missing public Firebase API key')
    web_ids = {item.get('client_id', '') for item in client.get('oauth_client', [])
               if item.get('client_type') == 3}
    if len(web_ids) != 1:
        raise ValueError('Enable Google Authentication, then download google-services.json again: missing Web OAuth client')
    web_id = web_ids.pop()
    if not re.fullmatch(r'[A-Za-z0-9_-]+\.apps\.googleusercontent\.com', web_id):
        raise ValueError('Invalid Web OAuth client identifier')
    return {'EXPO_PUBLIC_FIREBASE_PROJECT_ID': PROJECT,
            'EXPO_PUBLIC_FIREBASE_API_KEY': keys[0],
            'EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID': web_id}


def write_environment(path, values):
    # Preserve unrelated build settings; replace only the three validated keys.
    lines = path.read_text().splitlines() if path.exists() else []
    lines = [line for line in lines if line.split('=', 1)[0].strip() not in values]
    path.write_text('\n'.join(lines + [key + '=' + value for key, value in values.items()]) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('file', type=Path)
    parser.add_argument('--apply-local', action='store_true')
    args = parser.parse_args()
    try:
        values = extract(json.loads(args.file.read_text()))
    except (ValueError, OSError) as error:
        parser.exit(1, str(error) + '\n')
    if args.apply_local:
        write_environment(Path(__file__).resolve().parents[2] / '.env.local', values)
    print('Public configuration valid for chorescore-a75b1 / app.chorescore.v5. '
          + ('Ignored local build configuration saved.' if args.apply_local else 'No files or remote resources changed.'))


if __name__ == '__main__':
    main()
