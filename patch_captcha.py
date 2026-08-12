import pathlib
p1 = pathlib.Path('/mnt/e/ck/browser-automation-panel/tasks/host2play_yolo/captcha.py')
text = p1.read_text(encoding='utf-8')
text = text.replace(r'phrase = re.split(r"(?i)(if\b|click\b|there\b)", phrase)[0].strip()', r'phrase = re.split(r"(?i)(if\b|click\b|there\b|please\b|\n)", phrase)[0].strip()')
p1.write_text(text, encoding='utf-8')

p2 = pathlib.Path('/opt/browser-panel/tasks/host2play_yolo/captcha.py')
p2.write_text(text, encoding='utf-8')
