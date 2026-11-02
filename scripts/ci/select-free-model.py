"""Historical nonce/tool-call probe, with zero-price fallback models."""
import json
import os
from pathlib import Path
import secrets
import signal
import re
import subprocess
import tomllib
import urllib.request

folder = Path('verification-evidence/autopilot')
folder.mkdir(parents=True, exist_ok=True)
context = Path('.opencode-ci')
context.mkdir(exist_ok=True)
target = context / 'model-probe.txt'
results = []
for model in ['big-pickle', 'mimo-v2.5-free', 'deepseek-v4-flash-free', 'nemotron-3.5-lightning-free',
        'north-mini-code-free', 'laguna-s-2.1-free', 'hy3-free', 'ling-3.0-flash-free',
        'ling-3.0-tiny-free', 'nemotron-3-ultra-free', 'muse-spark-1.2-contributor-free', 'x-preview-f-free']:
    try:
        url = f'https://raw.githubusercontent.com/anomalyco/models.dev/dev/providers/opencode/models/{model}.toml'
        with urllib.request.urlopen(url, timeout=20) as response:
            metadata = tomllib.loads(response.read().decode())
        cost = metadata['cost']['text']
        if cost['input']['price'] != 0 or cost['output']['price'] != 0:
            results.append({'model': model, 'status': 'rejected-nonzero-price'})
            continue
        nonce = secrets.token_hex(24)
        target.write_text(nonce)
        config = json.loads(Path('opencode.json').read_text())
        config['model'] = config['small_model'] = 'opencode/' + model
        environment = dict(os.environ, OPENCODE_CONFIG_CONTENT=json.dumps(config))
        log = folder / (model + '-probe.jsonl')
        with log.open('w') as output:
            process = subprocess.Popen(['opencode', 'run', '--print-logs', '--log-level', 'ERROR', '--agent', 'build', '--model', 'opencode/' + model,
                '--format', 'json', 'Health probe only. Use a tool to read .opencode-ci/model-probe.txt. '
                'Reply with the exact file contents. Do not edit files or do any other work.'],
                env=environment, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
            try:
                status = process.wait(timeout=60)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
                status = 124
        events = []
        for line in log.read_text(errors='replace').splitlines():
            try:
                events.append(json.loads(line))
            except ValueError:
                pass
        text = ''.join(e.get('part', {}).get('text', '') for e in events if e.get('type') == 'text')
        healthy = status == 0 and nonce in text and not any(e.get('type') == 'error' for e in events)
        results.append({'model': model, 'status': 'tool-call-proved' if healthy else 'probe-failed', 'exitStatus': status})
        if healthy:
            with open(os.environ['GITHUB_ENV'], 'a') as output:
                output.write('AUTOPILOT_MODEL=opencode/' + model + '\n')
                output.write('OPENCODE_CONFIG_CONTENT=' + json.dumps(config) + '\n')
            print('::notice title=Free worker verified::' + model + ': zero pricing checked and a real tool-call nonce round-trip passed.', flush=True)
            break
    except Exception as error:
        results.append({'model': model, 'status': type(error).__name__})
    finally:
        target.unlink(missing_ok=True)
        (folder / 'model-probes.json').write_text(json.dumps(results, indent=2) + '\n')
        if results:
            print('::notice title=Free model probe::' + json.dumps(results[-1]), flush=True)
        probe_log = folder / (model + '-probe.jsonl')
        if probe_log.exists() and results and results[-1]['status'] != 'tool-call-proved':
            detail = probe_log.read_text(errors='replace')[-1800:]
            print('::notice title=Model startup diagnostic::' + detail.replace('%', '%25').replace('\r', '%0D').replace('\n', '%0A'), flush=True)
else:
    print('::error title=Free model availability::' + json.dumps(results), flush=True)
    # Server-side startup failures have only an opaque ref in JSON events.
    # Surface bounded error lines, never headers/tokens or arbitrary log files.
    logs = Path(os.environ.get('XDG_DATA_HOME', str(Path.home() / '.local/share'))) / 'opencode/log'
    files = sorted(logs.glob('*.log'), key=lambda p: p.stat().st_mtime, reverse=True)[:2]
    for file in files:
        lines = [line for line in file.read_text(errors='replace').splitlines()
            if re.search(r'UnknownError|ENOENT|EACCES|error=|stack=|api.?key|ECONN|failed', line, re.I)]
        detail = '\n'.join(lines)[-5000:]
        detail = re.sub(r'(?i)(bearer\s+|api.?key[=:]\s*)\S+', r'\1[REDACTED]', detail)
        print('::notice title=OpenCode server failure::' + detail.replace('%', '%25').replace('\r', '%0D').replace('\n', '%0A'), flush=True)
    print('::error::No zero-priced model proved an actual tool call. No paid fallback or fake worker started.')
    raise SystemExit(1)
