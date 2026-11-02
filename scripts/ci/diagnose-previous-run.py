"""Expose the exact previous failed verification in public check annotations.

Uses only the current runner's short-lived read-only Actions token. Never
prints credentials, changes code, dispatches jobs or contacts product users.
"""
import json
import os
import re
import urllib.request

repository = os.environ['GITHUB_REPOSITORY']
current = int(os.environ['GITHUB_RUN_ID'])
token = os.environ['GH_TOKEN']
api = 'https://api.github.com/repos/' + repository


def request(url):
    req = urllib.request.Request(url, headers={
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
    })
    with urllib.request.urlopen(req, timeout=45) as response:
        return response.read()


def annotation(message):
    message = message.replace(token, '[REDACTED]')
    message = re.sub(r'(?i)(authorization:\s*(?:bearer|basic)\s+)\S+', r'\1[REDACTED]', message)
    message = message.replace('%', '%25').replace('\r', '%0D').replace('\n', '%0A')
    print('::notice title=Previous acceptance failure::' + message, flush=True)


runs = json.loads(request(api + '/actions/workflows/product-acceptance.yml/runs?per_page=10'))['workflow_runs']
previous = next((run for run in runs if run['id'] != current and run['conclusion'] == 'failure'), None)
if previous is None:
    print('No previous failed acceptance run.')
else:
    jobs = json.loads(request(api + '/actions/runs/' + str(previous['id']) + '/jobs?per_page=100'))['jobs']
    for job in jobs:
        if job['conclusion'] != 'failure':
            continue
        failures = [step['name'] for step in job.get('steps', []) if step['conclusion'] == 'failure']
        annotation(f"Run {previous['id']}, {job['name']}: {', '.join(failures)}")
        try:
            log = request(api + '/actions/jobs/' + str(job['id']) + '/logs').decode('utf-8', errors='replace')
            # The API log has already been secret-masked by GitHub. Bound the
            # annotation so the failure remains accessible without a login.
            annotation(log[-7000:])
        except Exception as error:
            annotation('Log unavailable: ' + type(error).__name__)
