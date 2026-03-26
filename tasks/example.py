import json
import os
import shutil
import tempfile
from pathlib import Path


def main():
    result_path = os.environ.get('TASK_RESULT_PATH')
    screenshot_path = os.environ.get('TASK_SCREENSHOT_PATH')
    user_data_dir = os.environ.get('BROWSER_USER_DATA_DIR')
    chrome_path = os.environ.get('BROWSER_CHROME_PATH')
    proxy = os.environ.get('BROWSER_PROXY')
    payload = {'ok': False}
    tmp_dir = tempfile.mkdtemp(prefix='py-browser-task-')
    try:
        import subprocess
        payload = {'ok': True, 'screenshotPath': screenshot_path}
        cmd = [
            '/tmp/node-openclaw',
            '/home/abc61154321/browser-work/example.js'
        ]
        env = os.environ.copy()
        subprocess.run(cmd, check=True, env=env)
    except Exception as exc:
        payload = {'ok': False, 'error': str(exc)}
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        if result_path:
            with open(result_path, 'w', encoding='utf-8') as f:
                json.dump(payload, f, ensure_ascii=False, indent=2)
        if not payload.get('ok'):
            raise SystemExit(1)


if __name__ == '__main__':
    main()
