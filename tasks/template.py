import os
from pathlib import Path


def main():
    screenshots_dir = Path(os.environ.get('SCREENSHOTS_DIR', '.'))
    screenshots_dir.mkdir(parents=True, exist_ok=True)
    print('Python task template ready')


if __name__ == '__main__':
    main()
