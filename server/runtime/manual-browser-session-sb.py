import os
import signal
import sys
import time


try:
    from seleniumbase import Driver
except Exception as exc:  # pragma: no cover - runtime dependency check
    sys.stderr.write(f"Failed to import seleniumbase: {exc}\n")
    sys.exit(1)


driver = None


def _cleanup_and_exit(code=0):
    global driver
    if driver is not None:
        try:
            driver.quit()
        except Exception as exc:
            sys.stderr.write(f"{exc}\n")
    sys.exit(code)


def _handle_signal(_signum, _frame):
    _cleanup_and_exit(0)


def _build_driver():
    chrome_path = (os.environ.get("BROWSER_CHROME_PATH") or "").strip()
    user_data_dir = (os.environ.get("BROWSER_USER_DATA_DIR") or "").strip()
    proxy = (os.environ.get("BROWSER_PROXY") or "").strip()
    locale = (os.environ.get("BROWSER_LOCALE") or "").strip()

    kwargs = {
        "headless": False,
        "uc": True,
    }
    if chrome_path:
        kwargs["binary_location"] = chrome_path
    if user_data_dir:
        kwargs["user_data_dir"] = user_data_dir
    if proxy:
        kwargs["proxy"] = proxy
    if locale:
        kwargs["locale_code"] = locale
        kwargs["chromium_arg"] = [f"--lang={locale}"]

    try:
        return Driver(**kwargs)
    except TypeError:
        # Compatibility fallback for older seleniumbase argument signatures.
        for key in ("locale_code", "chromium_arg", "user_data_dir", "binary_location", "proxy"):
            kwargs.pop(key, None)
        return Driver(**kwargs)


def main():
    global driver
    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGHUP, _handle_signal)

    try:
        driver = _build_driver()
        driver.get("about:blank")
        sys.stdout.write(f"MANUAL_BROWSER_READY {os.getpid()}\n")
        sys.stdout.flush()
        while True:
            try:
                handles = driver.window_handles
                if not handles:
                    break
            except Exception:
                break
            time.sleep(1)
        _cleanup_and_exit(0)
    except Exception as exc:
        sys.stderr.write(f"{exc}\n")
        _cleanup_and_exit(1)


if __name__ == "__main__":
    main()
