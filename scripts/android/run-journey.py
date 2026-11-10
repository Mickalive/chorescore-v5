"""Run the real APK journey and retain a video, including on assertion failure.

Uses a disposable Android emulator, not a simulated repository or native mock.
The independent runner rejects missing/stale evidence even after exit code 0.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import threading


REQUIRED_CAPTURES = (
    'groups-empty-android', 'groups-filled-android', 'category-with-ratio-android',
    'todos-completed-android', 'reminder-delivered-android',
    'balances-before-restart-android', 'balances-after-restart-android',
    'photo-after-restart-android', 'native-share-android', 'notification-options-android',
    'compensation-preview-android', 'compensation-persisted-android',
)


def validate_evidence(directory, apk):
    report = json.loads((directory / 'result.json').read_text())
    if report.get('status') != 'passed':
        raise ValueError('Android journey did not pass')
    digest = hashlib.sha256(apk.read_bytes()).hexdigest()
    if report.get('apk_sha256') != digest:
        raise ValueError('Android evidence does not match the tested APK')
    for name in REQUIRED_CAPTURES:
        capture = directory / (name + '.png')
        if not capture.is_file() or capture.stat().st_size < 8 or capture.read_bytes()[:8] != b'\x89PNG\r\n\x1a\n':
            raise ValueError('Missing Android screenshot: ' + name)
        if not (directory / (name + '.xml')).is_file():
            raise ValueError('Missing Android UI hierarchy: ' + name)
    return report


def record_video(adb, directory, stopped):
    # Android screenrecord limits each clip to 180 seconds. Keep sequential
    # clips so later failures (photo/share/reminder) remain reviewable too.
    for index in range(100):
        if stopped.is_set():
            return
        remote = f'/sdcard/chorescore-journey-{index:03d}.mp4'
        process = subprocess.Popen([adb, 'shell', 'screenrecord', '--bit-rate', '1000000',
                                    '--time-limit', '175', remote],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        while process.poll() is None and not stopped.wait(1):
            pass
        if process.poll() is None:
            # SIGINT finalizes the MP4 before retrieving it.
            subprocess.run([adb, 'shell', 'pkill', '-2', 'screenrecord'], timeout=15,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            process.wait(timeout=15)
            subprocess.run([adb, 'pull', remote, str(directory / f'journey-{index:03d}.mp4')],
                           timeout=30, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except (subprocess.SubprocessError, OSError) as error:
            (directory / 'video-warning.txt').write_text(type(error).__name__)
            return
        finally:
            subprocess.run([adb, 'shell', 'rm', '-f', remote], timeout=15,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def main():
    apk = Path(sys.argv[1]).resolve()
    directory = Path(os.environ.get('ANDROID_EVIDENCE_DIR', 'android-evidence')).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    # Never let a previous iteration's success stand in for this execution.
    for name in ('result.json', 'failure.txt', 'journey-summary.json'):
        (directory / name).unlink(missing_ok=True)
    for name in REQUIRED_CAPTURES:
        for suffix in ('.png', '.xml'):
            (directory / (name + suffix)).unlink(missing_ok=True)
    stopped = threading.Event()
    recorder = threading.Thread(target=record_video,
        args=(os.environ.get('ADB_BIN', 'adb'), directory, stopped), daemon=True)
    recorder.start()
    code = 1
    error = None
    try:
        code = subprocess.call([sys.executable, str(Path(__file__).with_name('verify-device.py')), *sys.argv[1:]])
        if code == 0:
            validate_evidence(directory, apk)
    except (ValueError, OSError) as exc:
        error = str(exc)
        code = 1
    finally:
        stopped.set()
        recorder.join(timeout=65)
        summary = {'status': 'passed' if code == 0 else 'failed',
                   'apk_sha256': hashlib.sha256(apk.read_bytes()).hexdigest(),
                   'source_commit': os.environ.get('GITHUB_SHA'),
                   'environment': 'Android emulator', 'production_firebase_verified': False,
                   'error': error}
        (directory / 'journey-summary.json').write_text(json.dumps(summary, indent=2) + '\n')
        if os.environ.get('GITHUB_STEP_SUMMARY'):
            with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as output:
                output.write('### Android installed journey: ' + summary['status'] + '\n\n'
                    'Release APK: `' + summary['apk_sha256'] + '`\n\n'
                    'Evidence: screenshots, UI hierarchies, logcat and video clips in the Android artifact. '
                    'This local journey does not prove production Firebase or two-phone collaboration.\n')
    return code


if __name__ == '__main__':
    raise SystemExit(main())
