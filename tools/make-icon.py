# Draws the app icon: a test strip with five coloured pads on a dark tile.
# Run with: python tools/make-icon.py   (needs Pillow: pip install pillow)
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
S = 1024  # draw big, then shrink, so the edges come out smooth

img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle([40, 40, S - 40, S - 40], radius=200, fill=(23, 47, 61, 255))
# the strip, tilted slightly by drawing it on its own layer and rotating
strip = Image.new('RGBA', (S, S), (0, 0, 0, 0))
sd = ImageDraw.Draw(strip)
sd.rounded_rectangle([392, 110, 632, 914], radius=40, fill=(245, 245, 240, 255))
pads = [(140, 202, 196), (231, 225, 97), (240, 187, 166), (155, 128, 180), (63, 178, 127)]
for i, colour in enumerate(pads):
    top = 160 + i * 145
    sd.rounded_rectangle([432, top, 592, top + 110], radius=18, fill=colour + (255,))
img.alpha_composite(strip.rotate(-18, resample=Image.BICUBIC, center=(S / 2, S / 2)))

img.resize((512, 512), Image.LANCZOS).save(ROOT / 'desktop' / 'icon.png')
img.resize((256, 256), Image.LANCZOS).save(ROOT / 'build' / 'icon.ico',
                                           sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print('Wrote desktop/icon.png and build/icon.ico')
