"""Continue unfinished implementation, never an endless read-only audit."""
import json
from pathlib import Path
import sys


def has_product_progress(directory):
    for report in Path(directory).rglob('iterations.json'):
        try:
            rows = json.loads(report.read_text())
        except (OSError, ValueError):
            continue
        if not isinstance(rows, list):
            continue
        for row in rows:
            paths = row.get('productPaths') if isinstance(row, dict) else None
            if isinstance(paths, list) and any(isinstance(p, str) and
                (p.startswith(('src/', 'app/', 'backend/', 'firebase/', 'plugins/', 'assets/')) or p == 'app.json')
                for p in paths):
                return True
    return False


if __name__ == '__main__':
    raise SystemExit(0 if has_product_progress(sys.argv[1]) else 1)
