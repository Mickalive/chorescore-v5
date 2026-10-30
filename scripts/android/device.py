"""Native acceptance helper over adb-shell. No mock app or auth bypass.

Install adb-shell in a tooling venv, boot an Android emulator with TCP adbd,
then use: python device.py shell 'getprop sys.boot_completed'
             python device.py screenshot /tmp/screen.png
             python device.py install /path/to/candidate.apk
             python device.py hierarchy /tmp/window.xml
Keys live in ANDROID_USER_HOME, never in the repository or output.
"""
import os
import sys
from pathlib import Path
from adb_shell.adb_device import AdbDeviceTcp
from adb_shell.auth.sign_pythonrsa import PythonRSASigner
from adb_shell.auth.keygen import keygen

root = Path(os.environ.get('ANDROID_USER_HOME', '/workspace/.android'))
root.mkdir(parents=True, exist_ok=True)
key = root / 'adbkey'
if not key.exists():
    keygen(str(key))
    key.chmod(0o600)
signer = PythonRSASigner(key.with_suffix('.pub').read_text(), key.read_text())
device = AdbDeviceTcp('127.0.0.1', int(os.environ.get('ADB_TCP_PORT', '5555')), default_transport_timeout_s=30)
device.connect(rsa_keys=[signer], auth_timeout_s=30, transport_timeout_s=30, read_timeout_s=30)
try:
    command, *args = sys.argv[1:]
    if command == 'shell':
        for chunk in device.streaming_shell(args[0], transport_timeout_s=30, read_timeout_s=30):
            print(chunk,end='',flush=True)
    elif command == 'install':
        device.push(args[0], '/data/local/tmp/chorescore-candidate.apk', read_timeout_s=30)
        result = device.shell('pm install -r /data/local/tmp/chorescore-candidate.apk', read_timeout_s=30, timeout_s=55)
        print(result)
        if result.strip() != 'Success':
            raise SystemExit(1)
    elif command == 'screenshot':
        device.shell('screencap -p /data/local/tmp/chorescore-screen.png', read_timeout_s=30, timeout_s=55)
        device.pull('/data/local/tmp/chorescore-screen.png', args[0], read_timeout_s=30)
    elif command == 'hierarchy':
        print(device.shell('uiautomator dump /data/local/tmp/chorescore-window.xml', read_timeout_s=30, timeout_s=55))
        device.pull('/data/local/tmp/chorescore-window.xml', args[0], read_timeout_s=30)
    else:
        raise ValueError('Unknown command')
finally:
    device.close()
