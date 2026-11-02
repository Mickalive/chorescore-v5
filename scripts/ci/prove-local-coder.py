"""Prove actual local inference and a real read tool before product work."""
import json
import os
from pathlib import Path
import secrets
import subprocess

directory = Path('.opencode-ci')
directory.mkdir(exist_ok=True)
target = directory / 'model-probe.txt'
nonce = secrets.token_hex(24)
target.write_text(nonce)
log = Path('verification-evidence/autopilot/local-model-probe.jsonl')
try:
    with log.open('w') as output:
        result = subprocess.run(['opencode', 'run', '--agent', 'model-probe',
            '--model', os.environ['AUTOPILOT_MODEL'], '--format', 'json',
            'Use the read tool to read .opencode-ci/model-probe.txt. Return exactly its contents.'],
            stdout=output, stderr=subprocess.STDOUT, timeout=240)
    events = []
    for line in log.read_text(errors='replace').splitlines():
        try:
            events.append(json.loads(line))
        except ValueError:
            pass
    text = ''.join(e.get('part', {}).get('text', '') for e in events if e.get('type') == 'text')
    assert result.returncode == 0 and nonce in text and not any(e.get('type') == 'error' for e in events), log.read_text()[-4000:]
    if os.environ.get('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
            output.write('model=' + os.environ['AUTOPILOT_MODEL'] + '\n')
    print('::notice title=Free local worker proved::Actual CPU inference read a real file and returned its nonce; no inference API or billing used.')
finally:
    target.unlink(missing_ok=True)
