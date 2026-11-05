"""Bounded audit -> implement -> independently verify -> retain loop.

No publication credential is present in this worker. Publication happens in a
separate trusted job, and only a verified nonempty product patch is eligible.
"""
import json
import os
import hashlib
import shutil
import signal
import time
from pathlib import Path
import subprocess
from worker_protocol import run_worker, is_verified_product_patch
from resume_candidate import restore_candidate

ROOT = Path.cwd()
STARTED_AT = time.monotonic()
EVIDENCE = ROOT / 'verification-evidence' / 'autopilot'
EVIDENCE.mkdir(parents=True, exist_ok=True)
CONTEXT = ROOT / '.opencode-ci'
CONTEXT.mkdir(exist_ok=True)
BASE = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
TRACKED = set(subprocess.check_output(['git', 'ls-files'], text=True).splitlines())
MISSION = (ROOT / '.github/PRODUCT_AUTOPILOT.md').read_text()


def allowed(name):
    p = Path(name)
    if p.is_absolute() or '..' in p.parts or not p.parts:
        return False
    if any(part in {'.git', 'node_modules', '__pycache__', '.cache'} for part in p.parts):
        return False
    if p.suffix.lower() in {'.apk', '.jar', '.zip', '.db', '.sqlite', '.log', '.pyc'}:
        return False
    if p.name.startswith('.env') or p.is_symlink():
        return False
    if p.exists() and (not p.is_file() or p.stat().st_size > 2 * 1024 * 1024):
        return False
    if name == 'VERIFICATION.md' or name == 'app.json':
        return True
    if p.parts[0] in {'src', 'app', 'backend', 'firebase', 'plugins', 'assets'}:
        return True
    return p.parts[0] in {'tests', 'backend-tests'} and name not in TRACKED


def run(args, log, timeout):
    with log.open('w') as output:
        try:
            process = subprocess.Popen(args, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
            return process.wait(timeout=timeout) == 0
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            output.write('\nTIMEOUT: bounded execution stopped.\n')
            return False


def protect_controls():
    # Squash only unpublished commits inside this disposable CI checkout.
    subprocess.run(['git', 'reset', '--soft', BASE], check=True)
    names = subprocess.check_output(['git', 'diff', '--name-only', BASE], text=True).splitlines()
    for name in names:
        if name in TRACKED and not allowed(name):
            subprocess.run(['git', 'restore', '--source=' + BASE, '--staged', '--worktree', '--', name], check=True)
    # Nothing outside the allowlist is staged, including generated native files.
    subprocess.run(['git', 'reset'], check=True, stdout=subprocess.DEVNULL)
    names += subprocess.check_output(['git', 'ls-files', '--others', '--exclude-standard'], text=True).splitlines()
    for name in sorted(set(names)):
        if allowed(name):
            subprocess.run(['git', 'add', '-A', '--', name], check=True)


checks = [
    ('typecheck', ['npm', 'run', 'typecheck'], 180),
    ('application', ['npm', 'test'], 300),
    ('backend', ['npm', 'run', 'test:backend'], 180),
    ('firestore', ['npm', 'exec', '--yes', '--package=firebase-tools@14.22.0', '--',
        'firebase', 'emulators:exec', '--only', 'firestore', '--project', 'demo-chorescore-audit',
        'node scripts/firebase/verify-rules.cjs'], 420),
    ('browser', ['npm', 'run', 'test:web'], 240),
    ('android', ['bash', 'scripts/ci/native-acceptance.sh'], 3300),
]


def stop_local_model():
    marker = Path(os.environ['RUNNER_TEMP']) / 'chorescore-local-coder/server.pid'
    if not marker.exists():
        return
    pid = int(marker.read_text())
    command = Path('/proc') / str(pid) / 'cmdline'
    if command.exists() and b'llama-server' in command.read_bytes():
        os.kill(pid, signal.SIGTERM)
        for _ in range(50):
            if not command.exists():
                break
            __import__('time').sleep(.1)
        if command.exists() and b'llama-server' in command.read_bytes():
            os.kill(pid, signal.SIGKILL)
    marker.unlink(missing_ok=True)


# Release model RAM before Gradle/Chromium/SQLite checks. Reload cached local
# weights only when the next implementation pass actually starts.
stop_local_model()
(EVIDENCE / 'base.txt').write_text(BASE + '\n')
resumed = restore_candidate(CONTEXT / 'previous-worker', BASE, allowed)
if resumed:
    (EVIDENCE / 'resumed-candidate.json').write_text(json.dumps(resumed, indent=2) + '\n')
    print('Unpublished source restored onto the same revision; all acceptance gates remain mandatory.', flush=True)
records = []
verified = None
initial = []
previous = CONTEXT / 'previous-failures.md'
baseline_failed = False
for name, args, timeout in checks:
    log = EVIDENCE / f'baseline-{name}.log'
    passed = run(args, log, timeout)
    initial.append(f'## Baseline {name}: {"PASS" if passed else "FAIL"}' +
        ('' if passed else '\n' + log.read_text(errors='replace')[-18000:]))
    if not passed:
        baseline_failed = True
        message = log.read_text(errors='replace')[-6000:]
        print('::notice title=Concrete baseline failure::' + message.replace('%', '%25').replace('\r', '%0D').replace('\n', '%0A'), flush=True)
        break
if baseline_failed and previous.exists():
    initial.append('## Historical context (the current baseline above takes priority)\n' + previous.read_text()[-6000:])
(CONTEXT / 'latest-checks.md').write_text('\n\n'.join(initial))
last_checks = list(initial)
for attempt in range(1, 4):
    # Leave enough of the hosted job for its longest possible verification,
    # evidence upload and continuation; unfinished source resumes next run.
    if time.monotonic() - STARTED_AT >= 2 * 60 * 60:
        break
    if not run(['python3', 'scripts/ci/start-local-coder.py'], EVIDENCE / f'{attempt}-local-start.log', 900):
        raise SystemExit('Local CPU model failed to start; no paid fallback used.')
    prompt = MISSION + '\nPass ' + str(attempt) + '. Read .opencode-ci/latest-checks.md first if present. Implement real product changes now.'
    answered = run_worker(['opencode', 'run', '--agent', 'build', '--model', os.environ['AUTOPILOT_MODEL'],
        '--format', 'json', prompt], EVIDENCE / f'worker-{attempt}.jsonl', 1200)
    stop_local_model()
    events = []
    for line in (EVIDENCE / f'worker-{attempt}.jsonl').read_text(errors='replace').splitlines():
        try:
            events.append(json.loads(line))
        except ValueError:
            pass
    answered = answered and not any(e.get('type') == 'error' for e in events)
    protect_controls()
    paths = subprocess.check_output(['git', 'diff', '--cached', '--name-only'], text=True).splitlines()
    product = [p for p in paths if p.startswith(('src/', 'app/', 'backend/', 'firebase/', 'plugins/', 'assets/')) or p == 'app.json']
    outcomes = []
    context = []
    if not product:
        # A read-only pass must not erase the concrete failure for the next one.
        context.extend(last_checks)
        context.append('REJECTED: no executable product change; reports/tests alone do not complete the product.')
        context.append((EVIDENCE / f'worker-{attempt}.jsonl').read_text(errors='replace')[-6000:])
    for name, args, timeout in (checks if product else []):
        os.environ['AUTOPILOT_ATTEMPT'] = str(attempt)
        log = EVIDENCE / f'{attempt}-{name}.log'
        passed = run(args, log, timeout)
        outcomes.append({'check': name, 'passed': passed})
        context.append(f'## {name}: {"PASS" if passed else "FAIL"}' +
            ('' if passed else '\n' + log.read_text(errors='replace')[-18000:]))
        # First concrete failure is the next repair input. Do not spend time
        # rebuilding native artifacts while accounting/security is broken.
        if not passed:
            break
    if product:
        last_checks = list(context)
    (CONTEXT / 'latest-checks.md').write_text('\n\n'.join(context))
    # An interrupted model is not proof of a bad patch, and a confident final
    # message is not proof of a good one. Retain only actual source changes
    # that pass all six independent gates, including installed Android.
    passed = is_verified_product_patch(product, outcomes)
    records.append({'attempt': attempt, 'modelExitedSuccessfully': answered, 'productPaths': product,
        'checks': outcomes, 'verifiedProductPatch': passed})
    (EVIDENCE / 'iterations.json').write_text(json.dumps(records, indent=2) + '\n')
    patch = subprocess.check_output(['git', 'diff', '--cached', '--binary', BASE])
    (EVIDENCE / f'candidate-{attempt}.patch').write_bytes(patch)
    if passed:
        verified = patch
        (EVIDENCE / 'verified.patch').write_bytes(patch)
        (EVIDENCE / 'base.txt').write_text(BASE + '\n')
        apk = ROOT / 'android/app/build/outputs/apk/release/app-release.apk'
        shutil.copy2(apk, EVIDENCE / 'verified.apk')
        native = ROOT / 'verification-evidence/android'
        shutil.copytree(native, EVIDENCE / 'verified-native', dirs_exist_ok=True)
        (EVIDENCE / 'verified-candidate.json').write_text(json.dumps({
            'base': BASE, 'attempt': attempt,
            'patchSha256': hashlib.sha256(patch).hexdigest(),
            'apkSha256': hashlib.sha256(apk.read_bytes()).hexdigest(),
            'fullProductComplete': False,
        }, indent=2) + '\n')
        print('Verified product slice ready for integration; next workflow audits the remaining requirements.', flush=True)
        break

if verified is None:
    raise SystemExit('No verified product slice yet; unpublished candidates and exact failures retained for the next cycle.')
(EVIDENCE / 'verified.patch').write_bytes(verified)
