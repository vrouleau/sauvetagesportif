"""Generate icon.ico from icon.png with multiple sizes for Windows."""
from PIL import Image
from pathlib import Path

src = Path("packages/meet-app/resources/icon.png")
dst = Path("packages/meet-app/resources/icon.ico")

img = Image.open(src)
print(f"Source: {img.size[0]}x{img.size[1]}")

# Windows ico should have these sizes
sizes = [(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]

img.save(dst, format='ICO', sizes=sizes)
print(f"Created {dst} with sizes: {[f'{w}x{h}' for w,h in sizes]}")
