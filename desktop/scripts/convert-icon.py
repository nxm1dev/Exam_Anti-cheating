from PIL import Image
import os

src = os.path.join(os.path.dirname(__file__), "../../logo/EA.png")
out_dir = os.path.join(os.path.dirname(__file__), "../assets")
os.makedirs(out_dir, exist_ok=True)

img = Image.open(src).convert("RGBA")

# ICO with multiple sizes for Windows app icon
ico_path = os.path.join(out_dir, "icon.ico")
img.save(ico_path, format="ICO", sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])
print(f"Saved ICO: {ico_path}")

# PNG 512x512 for general use
png_path = os.path.join(out_dir, "icon.png")
img.resize((512, 512), Image.LANCZOS).save(png_path, format="PNG")
print(f"Saved PNG: {png_path}")
