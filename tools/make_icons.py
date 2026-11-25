"""icon/app-icon.png 이 있으면 앱 아이콘(안드로이드 5가지 크기 + 웹 192/512)을 만든다.
정사각형이 아니면 가운데를 정사각형으로 자르고, 512px 이상을 권장."""
import os, sys
from PIL import Image
SRC = 'icon/app-icon.png'
if not os.path.exists(SRC):
    print('icon/app-icon.png 없음 — 기존 아이콘 유지'); sys.exit(0)
im = Image.open(SRC).convert('RGBA')
w, h = im.size; s = min(w, h)
im = im.crop(((w - s) // 2, (h - s) // 2, (w - s) // 2 + s, (h - s) // 2 + s))
sizes = {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}
for d, px in sizes.items():
    im.resize((px, px), Image.LANCZOS).save(f'android/app/src/main/res/mipmap-{d}/ic_launcher.png')
for px in (192, 512):
    im.resize((px, px), Image.LANCZOS).save(f'docs/icon-{px}.png')
print('아이콘 생성 완료', im.size)
