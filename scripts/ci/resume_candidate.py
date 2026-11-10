"""Restore unpublished work only onto its exact upstream revision.

This is a disposable CI checkout. Restored source is still unverified and must
pass every independent gate before the separate publisher can integrate it.
"""
import json
import re
from pathlib import Path
import subprocess


def restore_candidate(directory, base, allowed):
    for report in sorted(Path(directory).rglob('iterations.json')):
        parent = report.parent
        marker = parent / 'base.txt'
        if not marker.exists() or marker.read_text().strip() != base:
            continue
        try:
            rows = json.loads(report.read_text())
        except (OSError, ValueError):
            continue
        if not isinstance(rows, list):
            continue
        for row in reversed(rows):
            if not isinstance(row, dict):
                continue
            if not row.get('productPaths'):
                continue
            attempt = row.get('attempt')
            if not isinstance(attempt, int) or not 1 <= attempt <= 3:
                continue
            patch = parent / f'candidate-{attempt}.patch'
            if not patch.exists() or patch.stat().st_size > 6 * 1024 * 1024:
                continue
            content = patch.read_bytes()
            if re.search(rb'(?m)^(?:new file mode|deleted file mode|old mode|new mode) 120000$', content):
                continue
            stats = subprocess.run(['git', 'apply', '--numstat', '-z', '-'], input=content,
                                   capture_output=True, check=False)
            if stats.returncode:
                continue
            entries = [entry.split(b'\t', 2) for entry in stats.stdout.split(b'\0') if entry]
            if not entries or any(len(entry) != 3 or not entry[2] for entry in entries):
                continue
            names = [entry[2].decode('utf-8') for entry in entries]
            if not all(allowed(name) for name in names):
                continue
            if subprocess.run(['git', 'apply', '--check', '--index', '-'], input=content,
                              capture_output=True).returncode:
                continue
            subprocess.run(['git', 'apply', '--index', '-'], input=content, check=True)
            if not all(allowed(name) for name in names):
                subprocess.run(['git', 'reset', '--hard', base], check=True, stdout=subprocess.DEVNULL)
                continue
            return {'attempt': attempt, 'paths': names, 'verified': False}
    return None
