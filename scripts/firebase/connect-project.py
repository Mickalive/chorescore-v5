#!/usr/bin/env python3
"""Run manually in Google's free Cloud Shell. No GitHub worker or private key.
Uses the user's existing gcloud consent; exports PUBLIC app configuration only.
"""
import argparse
import base64
import json
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PROJECT = 'chorescore-a75b1'
PACKAGE = 'app.chorescore.v5'


class SetupError(RuntimeError):
    pass


class GoogleAPI:
    def __init__(self, token):
        self.token = token

    def call(self, method, url, body=None, allow_missing=False):
        if not url.startswith('https://') or not urllib.parse.urlsplit(url).hostname.endswith('.googleapis.com'):
            raise SetupError('Adresse Google API non autorisée')
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(url, data=data, method=method, headers={
            'Authorization': 'Bearer ' + self.token, 'Content-Type': 'application/json',
            'X-Goog-User-Project': PROJECT,
        })
        try:
            with urllib.request.urlopen(request, timeout=40) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            if allow_missing and error.code == 404:
                return None
            # Never print request headers, bearer tokens or full API responses.
            raise SetupError(f'Google refuse {method} {urllib.parse.urlsplit(url).path} (HTTP {error.code}). Vérifie le compte et les droits sur {PROJECT}.') from None

    def operation(self, origin, result):
        deadline = time.monotonic() + 180
        while not result.get('done'):
            if time.monotonic() >= deadline:
                raise SetupError('Opération Google encore en cours ; relance cette même commande dans quelques minutes.')
            time.sleep(2)
            result = self.call('GET', origin + '/' + result['name'])
        if result.get('error'):
            raise SetupError('Google n’a pas terminé la configuration. Code : ' + str(result['error'].get('code', 'inconnu')))
        return result.get('response', {})


def ensure(api, method, url, body, apply):
    if not apply:
        raise SetupError('Configuration incomplète. Relance avec --apply pour appliquer les changements affichés dans le guide.')
    return api.call(method, url, body)


def connect(api, apply=False, interactive=True, output=None):
    project = api.call('GET', f'https://firebase.googleapis.com/v1beta1/projects/{PROJECT}')
    if project.get('projectId') != PROJECT:
        raise SetupError('Le projet retourné ne correspond pas à ChoreScore.')
    billing = api.call('GET', f'https://cloudbilling.googleapis.com/v1/projects/{PROJECT}/billingInfo')
    if billing.get('billingEnabled') is not False:
        raise SetupError('Arrêt : impossible de confirmer l’absence de facturation. Aucun changement effectué.')
    print('Projet confirmé ; facturation désactivée. Aucun service payant ne sera activé.')

    if apply:
        for service in ['firestore.googleapis.com', 'firebaserules.googleapis.com', 'identitytoolkit.googleapis.com']:
            url = f'https://serviceusage.googleapis.com/v1/projects/{PROJECT}/services/{service}'
            state = api.call('GET', url)
            if state.get('state') != 'ENABLED':
                api.operation('https://serviceusage.googleapis.com/v1', api.call('POST', url + ':enable', {}))

    db_url = f'https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/(default)'
    database = api.call('GET', db_url, allow_missing=True)
    if database is None:
        # The default database is the one eligible for the free Firestore quota.
        result = ensure(api, 'POST', f'https://firestore.googleapis.com/v1/projects/{PROJECT}/databases?databaseId=%28default%29',
                        {'locationId': 'eur3', 'type': 'FIRESTORE_NATIVE'}, apply)
        api.operation('https://firestore.googleapis.com/v1', result)
    elif database.get('type') != 'FIRESTORE_NATIVE':
        raise SetupError('La base existante n’est pas Firestore Native. Aucune conversion de données ne sera effectuée.')

    apps_url = f'https://firebase.googleapis.com/v1beta1/projects/{PROJECT}/androidApps'
    apps = api.call('GET', apps_url + '?pageSize=100').get('apps', [])
    app = next((item for item in apps if item.get('packageName') == PACKAGE), None)
    if app is None:
        operation = ensure(api, 'POST', apps_url, {'displayName': 'ChoreScore Android', 'packageName': PACKAGE}, apply)
        app = api.operation('https://firebase.googleapis.com/v1beta1', operation)
    app_name = app.get('name', '')
    if not app_name.startswith(f'projects/{PROJECT}/androidApps/') and not app_name.startswith(f"projects/{project.get('projectNumber')}/androidApps/"):
        raise SetupError('Identité de l’application Android inattendue.')
    manifest = json.loads((ROOT / 'firebase/android-signing.json').read_text())
    sha_url = 'https://firebase.googleapis.com/v1beta1/' + app_name + '/sha'
    existing = api.call('GET', sha_url).get('certificates', [])
    for kind, fingerprint in [('SHA_1', manifest['sha1']), ('SHA_256', manifest['sha256'])]:
        if not any(item.get('certType') == kind and item.get('shaHash', '').replace(':', '').lower() == fingerprint.lower() for item in existing):
            ensure(api, 'POST', sha_url, {'certType': kind, 'shaHash': fingerprint.upper()}, apply)

    provider_url = f'https://identitytoolkit.googleapis.com/admin/v2/projects/{PROJECT}/defaultSupportedIdpConfigs/google.com'
    provider = api.call('GET', provider_url, allow_missing=True)
    if not provider or not provider.get('enabled') or not provider.get('clientId'):
        print('\nUne action reste à faire dans Firebase :')
        print(f'https://console.firebase.google.com/project/{PROJECT}/authentication/providers')
        print('Clique Google → Activer, choisis ton adresse e-mail d’assistance, puis Enregistrer. Ne change pas de forfait.')
        if not interactive:
            raise SetupError('Le fournisseur Google doit être activé dans la console Firebase ; relance ensuite la même commande.')
        input('Quand Google est enregistré, appuie sur Entrée ici : ')
        provider = api.call('GET', provider_url, allow_missing=True)
    if not provider or not provider.get('enabled') or not provider.get('clientId'):
        raise SetupError('Google n’est pas encore activé. Relance cette même commande après enregistrement dans Firebase.')

    config = api.call('GET', 'https://firebase.googleapis.com/v1beta1/' + app_name + '/config')
    google_config = json.loads(base64.b64decode(config['configFileContents']))
    if google_config.get('project_info', {}).get('project_id') != PROJECT:
        raise SetupError('La configuration reçue concerne un autre projet Firebase.')
    if not provider['clientId'].endswith('.apps.googleusercontent.com'):
        raise SetupError('Le client Google OAuth configuré ne correspond pas au format attendu.')
    client = next((item for item in google_config.get('client', [])
                   if item.get('client_info', {}).get('android_client_info', {}).get('package_name') == PACKAGE), None)
    if not client:
        raise SetupError('Configuration Android manquante dans la réponse Google.')
    api_keys = client.get('api_key', [])
    if not api_keys or not api_keys[0].get('current_key'):
        raise SetupError('Google n’a pas encore fourni la clé API publique Firebase.')
    public = {'EXPO_PUBLIC_FIREBASE_PROJECT_ID': PROJECT,
              'EXPO_PUBLIC_FIREBASE_API_KEY': api_keys[0]['current_key'],
              'EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID': provider['clientId']}

    if apply:
        # Save the existing rules before replacing their release. No business
        # documents are read, rewritten, deleted or migrated by this script.
        rules_origin = 'https://firebaserules.googleapis.com/v1'
        release_url = f'{rules_origin}/projects/{PROJECT}/releases/cloud.firestore'
        release = api.call('GET', release_url, allow_missing=True)
        output.mkdir(parents=True, exist_ok=True)
        if release:
            previous = api.call('GET', rules_origin + '/' + release['rulesetName'])
            stamp = time.time_ns()
            (output / f'previous-firestore-rules-{stamp}.json').write_text(json.dumps(previous, indent=2))
        rules = (ROOT / 'firebase/firestore.rules').read_text()
        created = api.call('POST', f'{rules_origin}/projects/{PROJECT}/rulesets',
                           {'source': {'files': [{'name': 'firestore.rules', 'content': rules}]}})
        body = {'name': f'projects/{PROJECT}/releases/cloud.firestore', 'rulesetName': created['name']}
        if release:
            api.call('PATCH', release_url, {'release': body})
        else:
            api.call('POST', f'{rules_origin}/projects/{PROJECT}/releases', body)
        verified = api.call('GET', release_url)
        if verified.get('rulesetName') != created['name']:
            raise SetupError('Impossible de confirmer les règles publiées.')
        print('Règles Firestore du dépôt publiées et version active vérifiée.')
    print('\nConfiguration PUBLIQUE à copier dans la conversation (aucun jeton ni mot de passe) :')
    print(json.dumps(public, indent=2))
    if output:
        output.mkdir(parents=True, exist_ok=True)
        (output / 'chorescore-firebase-public.json').write_text(json.dumps(public, indent=2) + '\n')
    return public


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='Configurer le projet gratuit, Android, sa signature et publier les règles du dépôt')
    parser.add_argument('--non-interactive', action='store_true')
    args = parser.parse_args()
    try:
        result = subprocess.run(['gcloud', 'auth', 'print-access-token'], capture_output=True, text=True, check=True)
        token = result.stdout.strip()
        if not token:
            raise SetupError('La connexion Google du terminal n’est pas autorisée.')
        connect(GoogleAPI(token), args.apply, not args.non_interactive, ROOT / '.firebase-onboarding')
    except (SetupError, subprocess.CalledProcessError, FileNotFoundError, urllib.error.URLError) as error:
        print('Configuration interrompue : ' + (str(error) if isinstance(error, SetupError) else 'Connexion Google ou accès réseau indisponible. Ouvre le guide dans Google Cloud Shell.'), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
