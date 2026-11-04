"""Expose the exact previous failed verification in public check annotations.

Uses only the current runner's short-lived read-only Actions token. Never
prints credentials, changes code, dispatches jobs or contacts product users.
"""
import json
import os
import re
import subprocess
import urllib.request
import xml.etree.ElementTree as ET

repository = os.environ['GITHUB_REPOSITORY']
current = int(os.environ['GITHUB_RUN_ID'])
token = os.environ['GH_TOKEN']
api = 'https://api.github.com/repos/' + repository


def request(url):
    # gh handles GitHub's signed log-download redirects without forwarding
    # Authorization to the blob-storage hostname.
    return subprocess.check_output(['gh', 'api', '--allow-escape-sequences', url], timeout=60, stderr=subprocess.PIPE)


def annotation(message):
    message = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', message)
    message = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', '', message)
    message = message.replace(token, '[REDACTED]')
    message = re.sub(r'(?i)(authorization:\s*(?:bearer|basic)\s+)\S+', r'\1[REDACTED]', message)
    message = message.replace('%', '%25').replace('\r', '%0D').replace('\n', '%0A')
    print('::notice title=Previous acceptance failure::' + message, flush=True)


runs = json.loads(request(api + '/actions/workflows/product-acceptance.yml/runs?per_page=10'))['workflow_runs']
previous = None
jobs = []
branch = os.environ.get('GITHUB_REF_NAME')
for run in runs:
    if run['id'] == current or (branch and run.get('head_branch') != branch):
        continue
    # A failed browser check can be followed by a cancelled Android build.
    # The whole run then says "cancelled", but the failed job remains real.
    candidate_jobs = json.loads(request(api + '/actions/runs/' + str(run['id']) + '/jobs?per_page=100'))['jobs']
    if any(job.get('conclusion') == 'failure' for job in candidate_jobs):
        previous, jobs = run, candidate_jobs
        break
from pathlib import Path
context = Path('.opencode-ci')
context.mkdir(exist_ok=True)
summaries = []
if previous is None:
    print('No previous failed acceptance run.')
else:
    for job in jobs:
        if job['conclusion'] != 'failure':
            continue
        failures = [step['name'] for step in job.get('steps', []) if step['conclusion'] == 'failure']
        summaries.append(f"Run {previous['id']}, {job['name']}: {', '.join(failures)}")
        annotation(f"Run {previous['id']}, {job['name']}: {', '.join(failures)}")
        try:
            log = request(api + '/actions/jobs/' + str(job['id']) + '/logs').decode('utf-8', errors='replace')
            summaries.append(log[-18000:].replace(token, '[REDACTED]'))
            markers = list(dict.fromkeys(line for line in log.splitlines()
                if re.search(r'(?i)\b(error|fatal|invalid|unsupported|failed|timed out|timeout)\b', line)))
            if markers:
                important = markers[:8] + (markers[-4:] if len(markers) > 8 else [])
                annotation('Failure markers:\n' + '\n'.join(important)[:6000])
            # The API log has already been secret-masked by GitHub. Bound the
            # annotation so the failure remains accessible without a login.
            annotation(log[-7000:])
        except Exception as error:
            annotation('Log unavailable: ' + type(error).__name__)
            if isinstance(error, subprocess.CalledProcessError) and error.stderr:
                annotation(str(error.stderr)[-1500:])
        if job['name'] == 'android':
            destination = context / 'previous-android'
            downloaded = subprocess.run(['gh', 'run', 'download', str(previous['id']), '--repo', repository,
                '--name', 'android-evidence-' + previous['head_sha'], '--dir', str(destination)],
                capture_output=True, timeout=60)
            if downloaded.returncode == 0:
                for file in destination.rglob('latest-window.xml'):
                    try:
                        nodes = ET.fromstring(file.read_text()).iter('node')
                        screen = '\n'.join(' | '.join(str(node.get(key, '')) for key in
                            ['package', 'resource-id', 'text', 'content-desc', 'enabled'])
                            for node in nodes if any(node.get(key) for key in ['text', 'content-desc', 'resource-id']))
                        summaries.append('Actual failed Android screen:\n' + screen)
                        annotation('Actual failed Android screen:\n' + screen[-6500:])
                    except (ET.ParseError, OSError) as error:
                        annotation('Android hierarchy unreadable: ' + type(error).__name__)
                for file in destination.rglob('logcat.txt'):
                    lines = [line for line in file.read_text(errors='replace').splitlines()
                        if re.search(r'(?i)(ReactNativeJS.*(error|exception)|notification.*(error|exception|failed)|Alarm.*Exception)', line)]
                    if lines:
                        annotation('Android runtime errors:\n' + '\n'.join(lines[-20:])[-6500:])
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
    worker_jobs = json.loads(request(api + '/actions/runs/' + str(worker['id']) + '/jobs?per_page=100'))['jobs']
    if probe.returncode == 0 and any(job['name']=='free-model' and job.get('conclusion')=='failure' for job in worker_jobs):
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
        for pattern in ['*-android.log', '*-browser.log', 'worker-*.jsonl']:
            for file in sorted(destination.rglob(pattern)):
                content = file.read_text(errors='replace')
                if pattern == 'worker-*.jsonl':
                    events=[]
                    for line in content.splitlines():
                        try: events.append(json.loads(line))
                        except ValueError: pass
                    tools=[]
                    for event in events:
                        part=event.get('part',{}); state=part.get('state',{})
                        if event.get('type')=='tool_use':
                            tools.append({'tool':part.get('tool'),'status':state.get('status'),
                                'input':state.get('input'),'error':state.get('error')})
                    errors=[event for event in events if event.get('type')=='error']
                    annotation(file.name + ' actual tool actions/errors: ' + json.dumps({'tools':tools[-5:],'errors':errors[-2:]})[-6000:])
                else:
                    if 'android' in file.name:
                        failures = [line for line in content.splitlines() if re.search(
                            r'(?i)(ENOSPC|no space left|^ERROR|^Warning:|TIMEOUT|Traceback|AssertionError|command not found|failed)', line)]
                        annotation(file.name + ' failure details: ' + ('\n'.join(failures[-12:]) + '\n' + content[-1200:])[-6000:])
                    else:
                        annotation(file.name + ' last output: ' + content[-5000:])
