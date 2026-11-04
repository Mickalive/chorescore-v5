"""A read-only reply is insufficient: require a real red/green code repair."""
import json
import os
from pathlib import Path
import hashlib
import random
import subprocess
from worker_protocol import run_worker

directory = Path('.opencode-ci')
directory.mkdir(exist_ok=True)
directory = directory / 'code-probe'
directory.mkdir(exist_ok=True)
target = directory / 'sum.cjs'
target.write_text('module.exports = (a, b) => String(a) + String(b);\n')
test = directory / 'test.cjs'
cases = [[101,2],[-5,3],[0,0]] + [[random.randint(-1000,1000),random.randint(-1000,1000)] for _ in range(10)]
test.write_text("const assert=require('node:assert/strict'); const sum=require('./sum.cjs');\n"+
    'for (const [a,b] of '+json.dumps(cases)+') assert.equal(sum(a,b),a+b);\n')
original = target.read_bytes()
test_digest = hashlib.sha256(test.read_bytes()).hexdigest()
assert subprocess.run(['node',str(test)],capture_output=True).returncode != 0, 'Broken fixture must actually fail'
log = Path('verification-evidence/autopilot/local-model-probe.jsonl')
try:
    succeeded = run_worker(['opencode', 'run', '--agent', 'model-probe',
            '--model', os.environ['AUTOPILOT_MODEL'], '--format', 'json',
            'Repair .opencode-ci/code-probe/sum.cjs so it adds two numbers rather than concatenating strings. Read it, edit the source, then run node .opencode-ci/code-probe/test.cjs. Do not edit the test. Do not delegate or call task.'],
            log, 600)
    events = []
    for line in log.read_text(errors='replace').splitlines():
        try:
            events.append(json.loads(line))
        except ValueError:
            pass
    assert succeeded and not any(e.get('type') == 'error' for e in events), log.read_text()[-4000:]
    assert target.read_bytes() != original, 'No source repair was made'
    assert hashlib.sha256(test.read_bytes()).hexdigest() == test_digest, 'Worker changed the test instead of repairing source'
    subprocess.run(['node',str(test)],check=True)
    if os.environ.get('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
            output.write('model=' + os.environ['AUTOPILOT_MODEL'] + '\n')
    print('::notice title=Free local repair proved::The original source failed; OpenCode changed the source, preserved the test and passed all numeric cases. This is a capability probe, not a product feature.')
except Exception:
    detail = log.read_text(errors='replace')[-5000:] if log.exists() else 'No probe transcript was produced.'
    print('::error title=Free model repair failed::' + detail.replace('%', '%25').replace('\r', '%0D').replace('\n', '%0A'), flush=True)
    raise
finally:
    target.unlink(missing_ok=True)
    test.unlink(missing_ok=True)
