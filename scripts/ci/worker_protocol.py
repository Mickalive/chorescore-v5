"""Detect an actual tool loop instead of waiting twenty minutes for a timeout."""
import json
import os
import selectors
import signal
import subprocess
import time


def run_worker(args, log, timeout):
    progress = WorkerProgress()
    process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
    deadline = time.monotonic() + timeout
    failure = None
    pending = b''
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    try:
        with log.open('wb') as output:
            while True:
                if time.monotonic() >= deadline:
                    failure = 'Worker deadline exceeded; preserve the candidate and inspect the transcript.'
                    break
                if not selector.select(timeout=min(1, max(0, deadline-time.monotonic()))):
                    continue
                chunk = os.read(process.stdout.fileno(), 65536)
                if not chunk:
                    break
                output.write(chunk)
                output.flush()
                pending += chunk
                while b'\n' in pending:
                    line, pending = pending.split(b'\n', 1)
                    try:
                        failure = progress.accept(json.loads(line))
                    except (ValueError, UnicodeError):
                        continue
                    if failure:
                        break
                if failure:
                    break
            if failure:
                output.write(('\nSTOPPED: ' + failure + '\n').encode())
    finally:
        selector.close()
        if process.poll() is None and failure is None:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                failure = 'Worker closed output but did not exit.'
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
        process.stdout.close()
    return failure is None and process.returncode == 0


class WorkerProgress:
    def __init__(self):
        self.failures = 0
        self.tool_calls = 0
        self.edits = 0

    def accept(self, event):
        if event.get('type') != 'tool_use':
            return None
        part = event.get('part', {})
        self.tool_calls += 1
        tool = part.get('tool')
        if tool == 'task':
            return 'Delegation is forbidden: implement directly instead of calling task.'
        state = part.get('state', {})
        if state.get('status') == 'error':
            self.failures += 1
            if self.failures >= 3:
                return 'Three consecutive tool errors without a successful action: ' + str(state.get('error', ''))[:1000]
        elif state.get('status') == 'completed':
            self.failures = 0
            if tool in {'edit', 'write', 'apply_patch'}:
                self.edits += 1
        return None
