"""Browser QA through the user's local Kimi WebBridge. Local pages only."""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile

SESSION = '333-review-demo-20261004'


def bridge(action, args=None):
    payload = {'action': action, 'args': args or {}, 'session': SESSION}
    with tempfile.NamedTemporaryFile(mode='w', suffix='.json', prefix='review-demo-', encoding='utf-8', delete=False) as file:
        json.dump(payload, file, ensure_ascii=False)
        filename = file.name
    try:
        result = subprocess.run(['curl.exe', '-s', '--max-time', '35', '-X', 'POST', 'http://127.0.0.1:10086/command', '-H', 'Content-Type: application/json', '--data-binary', '@' + filename], capture_output=True, encoding='utf-8')
        if result.returncode:
            raise RuntimeError(result.stderr)
        response = json.loads(result.stdout)
        if response.get('ok') is False or response.get('error') or response.get('success') is False:
            raise RuntimeError(json.dumps(response, ensure_ascii=False))
        return response
    finally:
        Path(filename).unlink(missing_ok=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('action')
    parser.add_argument('--args-file')
    args = parser.parse_args()
    values = json.loads(Path(args.args_file).read_text(encoding='utf-8')) if args.args_file else {}
    print(json.dumps(bridge(args.action, values), ensure_ascii=False))
