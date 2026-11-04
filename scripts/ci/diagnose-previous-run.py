"""Expose the exact previous failed verification in public check annotations.

Uses only the current runner's short-lived read-only Actions token. Never
prints credentials, changes code, dispatches jobs or contacts product users.
"""
import json
import os
import re
import subprocess
import urllib.request

repository = os.environ['GITHUB_REPOSITORY']
current = int(os.environ['GITHUB_RUN_ID'])
token = os.environ['GH_TOKEN']
api = 'https://api.github.com/repos/' + repository


def request(url):
    # gh handles GitHub's signed log-download redirects without forwarding
    # Authorization to the blob-storage hostname.
    return subprocess.check_output(['gh', 'api', url], timeout=60, stderr=subprocess.PIPE)


def annotation(message):
    message = message.replace(token, '[REDACTED]')
    message = re.sub(r'(?i)(authorization:\s*(?:bearer|basic)\s+)\S+', r'\1[REDACTED]', message)
    message = message.replace('%', '%25').replace('\r', '%0D').replace('\n', '%0A')
    print('::notice title=Previous acceptance failure::' + message, flush=True)


runs = json.loads(request(api + '/actions/workflows/product-acceptance.yml/runs?per_page=10'))['workflow_runs']
previous = next((run for run in runs if run['id'] != current and run['conclusion'] == 'failure'), None)
from pathlib import Path
context = Path('.opencode-ci')
context.mkdir(exist_ok=True)
summaries = []
if previous is None:
    print('No previous failed acceptance run.')
else:
    jobs = json.loads(request(api + '/actions/runs/' + str(previous['id']) + '/jobs?per_page=100'))['jobs']
    for job in jobs:
        if job['conclusion'] != 'failure':
            continue
        failures = [step['name'] for step in job.get('steps', []) if step['conclusion'] == 'failure']
        summaries.append(f"Run {previous['id']}, {job['name']}: {', '.join(failures)}")
        annotation(f"Run {previous['id']}, {job['name']}: {', '.join(failures)}")
        try:
            log = request(api + '/actions/jobs/' + str(job['id']) + '/logs').decode('utf-8', errors='replace')
            summaries.append(log[-18000:].replace(token, '[REDACTED]'))
            # The API log has already been secret-masked by GitHub. Bound the
            # annotation so the failure remains accessible without a login.
            annotation(log[-7000:])
        except Exception as error:
            annotation('Log unavailable: ' + type(error).__name__)
            if isinstance(error, subprocess.CalledProcessError) and error.stderr:
                annotation(str(error.stderr)[-1500:])
(context / 'previous-failures.md').write_text('\n\n'.join(summaries))

worker_runs = json.loads(request(api + '/actions/workflows/product-autopilot.yml/runs?per_page=10'))['workflow_runs']
worker = next((run for run in worker_runs if run['id'] != current and run['conclusion'] == 'failure'), None)
if worker:
    # A failed capability probe never creates product-reconstruction evidence.
    # Retrieve its own artifact instead of silently losing the actual failure.
    probe_destination = context / 'previous-probe'
    probe = subprocess.run(['gh', 'run', 'download', str(worker['id']), '--repo', repository,
        '--name', 'free-model-proof-' + str(worker['id']), '--dir', str(probe_destination)],
        capture_output=True, timeout=60)
    if probe.returncode == 0:
        for file in probe_destination.rglob('*probe.jsonl'):
            annotation('Previous capability probe: ' + file.read_text(errors='replace')[-5500:])
    destination = context / 'previous-worker'
    result = subprocess.run(['gh', 'run', 'download', str(worker['id']), '--repo', repository,
        '--name', 'product-reconstruction-' + str(worker['id']), '--dir', str(destination)],
        capture_output=True, timeout=60)
    if result.returncode == 0:
        for file in destination.rglob('model-probes.json'):
            annotation('Previous free model probes: ' + file.read_text()[-5000:])
        for file in destination.rglob('*-probe.jsonl'):
            annotation(file.name + ': ' + file.read_text(errors='replace')[-2500:])
        for pattern in ['*-android.log', '*-browser.log', 'local-model-server.log', 'worker-*.jsonl']:
            for file in sorted(destination.rglob(pattern)):
                content = file.read_text(errors='replace')
                if pattern == 'worker-*.jsonl':
                    events=[]
                    for line in content.splitlines():
                        try: events.append(json.loads(line))
                        except ValueError: pass
                    annotation(file.name + ' event types: ' + json.dumps([e.get('type') for e in events]))
                    annotation(file.name + ' first events: ' + content[:3500])
                annotation(file.name + ' last output: ' + content[-5000:])
