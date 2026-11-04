"""Bounded audit -> implement -> independently verify -> retain loop.

No publication credential is present in this worker. Publication happens in a
separate trusted job, and only a verified nonempty product patch is eligible.
"""
import json
import os
import hashlib
import shutil
import signal
from pathlib import Path
import subprocess
from worker_protocol import run_worker

ROOT = Path.cwd()
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
    ('android', ['bash', 'scripts/ci/native-acceptance.sh'], 1800),
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
records = []
verified = None
initial = []
previous = CONTEXT / 'previous-failures.md'
if previous.exists():
    initial.append(previous.read_text())
for name, args, timeout in checks[:4]:
    log = EVIDENCE / f'baseline-{name}.log'
    passed = run(args, log, timeout)
    initial.append(f'## Baseline {name}: {"PASS" if passed else "FAIL"}\n' + log.read_text(errors='replace')[-18000:])
    if not passed:
        message = log.read_text(errors='replace')[-6000:]
        print('::notice title=Concrete baseline failure::' + message.replace('%', '%25').replace('\r', '%0D').replace('\n', '%0A'), flush=True)
        break
(CONTEXT / 'latest-checks.md').write_text('\n\n'.join(initial))
for attempt in range(1, 4):
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
    answered = answered and any(e.get('type') == 'text' for e in events) and not any(e.get('type') == 'error' for e in events)
    protect_controls()
    paths = subprocess.check_output(['git', 'diff', '--cached', '--name-only'], text=True).splitlines()
    product = [p for p in paths if p.startswith(('src/', 'app/', 'backend/', 'firebase/', 'plugins/', 'assets/')) or p == 'app.json']
    outcomes = []
    context = []
    if not product:
        context.append('REJECTED: no executable product change; reports/tests alone do not complete the product.')
        context.append((EVIDENCE / f'worker-{attempt}.jsonl').read_text(errors='replace')[-6000:])
    for name, args, timeout in (checks if product else []):
        os.environ['AUTOPILOT_ATTEMPT'] = str(attempt)
        log = EVIDENCE / f'{attempt}-{name}.log'
        passed = run(args, log, timeout)
        outcomes.append({'check': name, 'passed': passed})
        context.append(f'## {name}: {"PASS" if passed else "FAIL"}\n' + log.read_text(errors='replace')[-18000:])
        # First concrete failure is the next repair input. Do not spend time
        # rebuilding native artifacts while accounting/security is broken.
        if not passed:
            break
    (CONTEXT / 'latest-checks.md').write_text('\n\n'.join(context))
    passed = answered and bool(product) and len(outcomes) == len(checks) and all(row['passed'] for row in outcomes)
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
        print('Verified product slice retained; continuing the next remaining requirement.', flush=True)
    elif verified is not None:
        # Failed experiments must not replace the strongest verified source.
        subprocess.run(['git', 'reset', '--hard', BASE], check=True)
        # Remove only this disposable worker's new allowed source files; never
        # remove preserved evidence, dependencies or a user's workspace.
        for name in subprocess.check_output(['git', 'ls-files', '--others', '--exclude-standard'], text=True).splitlines():
            if allowed(name):
                Path(name).unlink(missing_ok=True)
        subprocess.run(['git', 'apply', '--index', '-'], input=verified, check=True)

if verified is None:
    raise SystemExit('No verified product slice after three bounded iterations; candidates and exact failures preserved.')
(EVIDENCE / 'verified.patch').write_bytes(verified)
