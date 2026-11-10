#!/usr/bin/env bash
# Only disposable public GitHub-hosted runners; never a developer's machine.
set -euo pipefail
test "${GITHUB_ACTIONS:-}" = true
test "${RUNNER_ENVIRONMENT:-}" = github-hosted
test "${RUNNER_OS:-}" = Linux
python3 - <<'PY'
import json, os
with open(os.environ['GITHUB_EVENT_PATH']) as event:
    assert json.load(event)['repository']['private'] is False, 'Public repository required'
PY
df -h "$GITHUB_WORKSPACE"
# These preinstalled toolchains are unused by React Native, Java and llama.cpp.
# Keep the Android SDK, Java, Node, browser, Docker and all workspace/cache data.
sudo rm -rf -- /usr/share/dotnet /usr/local/share/powershell /opt/ghc
df -h "$GITHUB_WORKSPACE"
