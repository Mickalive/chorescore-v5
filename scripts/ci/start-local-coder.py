"""Start a genuinely free CPU model: no inference API/account/billing.

Only standard hosted runners in this public repository are authorized. Model
weights are public Apache-2.0, pinned to the returned immutable HF revision and
verified against its Git-LFS SHA-256. They are never uploaded as artifacts.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request

assert os.environ.get('GITHUB_ACTIONS') == 'true', 'Disposable GitHub runner required'
root = Path(os.environ['RUNNER_TEMP']) / 'chorescore-local-coder'
root.mkdir(exist_ok=True)
evidence = Path('verification-evidence/autopilot')
evidence.mkdir(parents=True, exist_ok=True)
repository = 'Qwen/Qwen3-8B-GGUF'


def get_json(url):
    with urllib.request.urlopen(url, timeout=45) as response:
        return json.load(response)


info = get_json('https://huggingface.co/api/models/' + repository)
assert info.get('cardData', {}).get('license') == 'apache-2.0', 'Unverified model license'
revision = info['sha']
tree = get_json(f'https://huggingface.co/api/models/{repository}/tree/{revision}?recursive=true&expand=true')
files = [item for item in tree if item.get('path', '').endswith('.gguf') and 'Q4_K_M' in item['path'].upper()]
assert 1 <= len(files) <= 4, 'Expected the bounded official Q4_K_M weight files'
manifest = []
for item in sorted(files, key=lambda item: item['path']):
    name = Path(item['path'])
    assert not name.is_absolute() and '..' not in name.parts
    digest = item['lfs']['oid']
    assert len(digest) == 64 and all(c in '0123456789abcdef' for c in digest)
    destination = root / 'model' / name
    destination.parent.mkdir(parents=True, exist_ok=True)
    if not destination.exists():
        subprocess.run(['curl', '--fail', '--location', '--max-time', '600', '--retry', '2',
            f'https://huggingface.co/{repository}/resolve/{revision}/{item["path"]}',
            '--output', str(destination)], check=True)
    actual = hashlib.file_digest(destination.open('rb'), 'sha256').hexdigest()
    assert actual == digest, 'Model file checksum mismatch'
    manifest.append({'file': item['path'], 'sha256': digest})

source = root / 'llama.cpp'
commit = '8642541b255bfb5dc39cd351a178be09013a55d6'
if not source.exists():
    subprocess.run(['git', 'clone', '--depth', '1', '--branch', 'v0.8.0',
        'https://github.com/ggml-org/llama.cpp.git', str(source)], check=True)
assert subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip() == commit
subprocess.run(['cmake', '-S', str(source), '-B', str(root / 'build'), '-G', 'Ninja',
    '-DCMAKE_BUILD_TYPE=Release', '-DGGML_CUDA=OFF', '-DLLAMA_BUILD_TESTS=OFF',
    '-DLLAMA_BUILD_EXAMPLES=OFF', '-DLLAMA_BUILD_SERVER=ON'], check=True)
subprocess.run(['cmake', '--build', str(root / 'build'), '--target', 'llama-server', '-j', '4'], check=True)
server_log = (evidence / 'local-model-server.log').open('w')
server = subprocess.Popen([str(root / 'build/bin/llama-server'),
    '--model', str(root / 'model' / sorted(files, key=lambda item: item['path'])[0]['path']),
    '--host', '127.0.0.1', '--port', '18080', '--alias', 'chorescore-coder',
    '--ctx-size', '32768', '--parallel', '1', '--threads', '4', '--jinja',
    '--chat-template-kwargs', '{"enable_thinking":false}'],
    stdout=server_log, stderr=subprocess.STDOUT, start_new_session=True)
(root / 'server.pid').write_text(str(server.pid))
for attempt in range(120):
    if server.poll() is not None:
        raise RuntimeError('Local model server exited: ' + (evidence / 'local-model-server.log').read_text()[-3000:])
    try:
        if get_json('http://127.0.0.1:18080/health').get('status') == 'ok':
            break
    except Exception:
        time.sleep(2)
else:
    raise RuntimeError('Local CPU model failed readiness')

config = json.loads(Path('opencode.json').read_text())
model = 'local-coder/chorescore-coder'
config['model'] = config['small_model'] = model
config['enabled_providers'] = ['local-coder']
config['provider'] = {'local-coder': {
    'npm': '@ai-sdk/openai-compatible', 'name': 'Free local CPU coder',
    'options': {'baseURL': 'http://127.0.0.1:18080/v1', 'apiKey': 'local-no-billing'},
    'models': {'chorescore-coder': {'name': 'Qwen3 8B CPU',
        'limit': {'context': 32768, 'output': 8192}, 'cost': {'input': 0, 'output': 0}}},
}}
config['agent']['model-probe'] = {
    'mode': 'primary', 'description': 'Prove a real source repair and execute its test',
    'prompt': 'Directly read and edit the assigned scratch source file. The independent controller runs the unchanged test immediately after your edit. Do not delegate or call task. Do not modify the test. No other work.',
    'steps': 8, 'permission': {'task': 'deny', 'question': 'deny'},
}
with open(os.environ['GITHUB_ENV'], 'a') as output:
    output.write('AUTOPILOT_MODEL=' + model + '\n')
    output.write('OPENCODE_CONFIG_CONTENT=' + json.dumps(config) + '\n')
(evidence / 'local-model.json').write_text(json.dumps({
    'repository': repository, 'revision': revision, 'license': 'apache-2.0',
    'files': manifest, 'runtimeCommit': commit, 'inferenceEndpoint': 'localhost-only',
    'paidInferenceApiUsed': False,
}, indent=2) + '\n')
print('Local CPU model ready; no remote inference API or payment credential.', flush=True)
