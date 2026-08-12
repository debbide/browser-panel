from seleniumbase import SB


def run():
    with SB(uc=True, test=True, headless2=False) as sb:
        sb.open("https://example.com/login")
        sb.wait_for_element_visible("#email", timeout=12)
        sb.type("#email", "demo@example.com")
        sb.wait_for_element_visible("#password", timeout=12)
        sb.type("#password", "{{PASSWORD}}")
        sb.wait_for_element_visible("button[type='submit']", timeout=12)
        sb.click("button[type='submit']")
        sb.sleep(1.50)
        sb.assert_true("dashboard" in sb.get_current_url())
        sb.wait_for_element_visible(".user-menu", timeout=12)
        sb.hover(".user-menu")
        sb.wait_for_element_visible("input[name='search']", timeout=12)
        sb.press_keys("input[name='search']", "Enter")
        sb.execute_script("window.scrollTo(arguments[0], arguments[1]);", 0, 600)
        sb.save_screenshot("after-login.png")


if __name__ == '__main__':
    run()
