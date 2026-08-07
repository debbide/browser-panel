import os
import signal
import sys
import time

from ruyipage_adapter import launch_browser


page = None


def cleanup_and_exit(code=0):
    global page
    if page is not None:
        try:
            page.quit()
        except Exception as exc:
            sys.stderr.write(f"{exc}\n")
    sys.exit(code)


def handle_signal(_signum, _frame):
    cleanup_and_exit(0)


def main():
    global page
    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGHUP, handle_signal)
    try:
        page = launch_browser()
        sys.stdout.write(f"MANUAL_BROWSER_READY {os.getpid()}\n")
        sys.stdout.flush()
        while True:
            time.sleep(1)
    except Exception as exc:
        sys.stderr.write(f"{exc}\n")
        cleanup_and_exit(1)


if __name__ == "__main__":
    main()
