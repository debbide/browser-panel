import pathlib

patch_func = """
def _click_reload(page) -> None:
    bframe = find_frame(page, "bframe", timeout=4)
    if not bframe: return
    try:
        btn = bframe.ele("#recaptcha-reload-button", timeout=3)
        if btn:
            safe_click(btn)
            log("Reload clicked")
    except Exception as e:
        log(f"Reload failed: {e}", "WARN")

def _click_verify(page) -> None:"""

patch_logic = """        if not dynamic:
            if not clicked:
                log("[经理] 静态：本轮无匹配，点击刷新换题")
                _click_reload(page)
                time.sleep(3.5)
            else:
                # 静态：点完就点验证
                time.sleep(0.35)
                log("[经理] 静态：点击验证")
                _click_verify(page)
                time.sleep(2.5)
                ok = is_recaptcha_solved(page)
                log(f"[经理] 静态验证结果 -> {ok}")
                if ok:
                    return True
                log("[经理] 静态验证未通过，可能出现了下一题，继续进行下一轮挑战！")
            time.sleep(1.0)
            t2 = read_target(page)
            if t2:
                target = t2
            continue"""

def apply_patch(p_str):
    p = pathlib.Path(p_str)
    text = p.read_text(encoding='utf-8')
    
    # insert _click_reload before _click_verify
    if "def _click_reload" not in text:
        text = text.replace("def _click_verify(page) -> None:", patch_func)
    
    # replace static verification block
    old_logic = """        if not dynamic:
            # 静态：点完就点验证
            time.sleep(0.35)
            log("[经理] 静态：点击验证")
            _click_verify(page)
            time.sleep(2.5)
            ok = is_recaptcha_solved(page)
            log(f"[经理] 静态验证结果 -> {ok}")
            if ok:
                return True
            log("[经理] 静态验证未通过，可能出现了下一题，继续进行下一轮挑战！")
            time.sleep(1.0)
            t2 = read_target(page)
            if t2:
                target = t2
            continue"""
    if old_logic in text:
        text = text.replace(old_logic, patch_logic)
        
    p.write_text(text, encoding='utf-8')

apply_patch('/mnt/e/ck/browser-automation-panel/tasks/host2play_yolo/captcha.py')
apply_patch('/opt/browser-panel/tasks/host2play_yolo/captcha.py')
print("Patch applied")
