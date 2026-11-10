"""Detect an actual tool loop instead of waiting twenty minutes for a timeout."""
import json
import os
import selectors
import signal
import subprocess
import time


def all_checks_passed(outcomes):
    required = {'typecheck', 'application', 'backend', 'firestore', 'browser', 'android'}
    return (len(outcomes) == len(required)
            and {row.get('check') for row in outcomes} == required
            and all(row.get('passed') is True for row in outcomes))


def is_verified_product_patch(product_paths, outcomes):
    return bool(product_paths) and all_checks_passed(outcomes)


def run_worker(args, log, timeout, verified_when=None):
    progress = WorkerProgress()
    process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
    deadline = time.monotonic() + timeout
    failure = None
    verified = False
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
                        event = json.loads(line)
                        failure = progress.accept(event)
                        if failure is None and verified_when is not None:
                            verified = verified_when(event)
                    except (ValueError, UnicodeError):
                        continue
                    if failure or verified:
                        break
                if failure or verified:
                    break
            if failure:
                output.write(('\nSTOPPED: ' + failure + '\n').encode())
            elif verified:
                output.write(b'\nVERIFIED: trusted acceptance callback passed; stop the probe process.\n')
    finally:
        selector.close()
        if process.poll() is None and failure is None and not verified:
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
    return failure is None and (verified or process.returncode == 0)


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
