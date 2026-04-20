from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageColor, ImageDraw, ImageFilter, ImageFont


ROOT = Path(__file__).resolve().parent
ICON_PNG = ROOT / "launcher-icon.png"
ICON_ICO = ROOT / "launcher-icon.ico"
WIZARD_BMP = ROOT / "installer-wizard.bmp"
WIZARD_SMALL_BMP = ROOT / "installer-small.bmp"


def load_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for name in ("msyh.ttc", "seguiemj.ttf", "arial.ttf"):
        try:
            return ImageFont.truetype(name, size=size)
        except Exception:
            continue
    return ImageFont.load_default()


def gradient_background(size: tuple[int, int], start: str, end: str) -> Image.Image:
    width, height = size
    start_rgb = ImageColor.getrgb(start)
    end_rgb = ImageColor.getrgb(end)
    image = Image.new("RGBA", size)
    draw = ImageDraw.Draw(image)
    for y in range(height):
        ratio = y / max(1, height - 1)
        color = tuple(int(start_rgb[i] + (end_rgb[i] - start_rgb[i]) * ratio) for i in range(3))
        draw.line((0, y, width, y), fill=color)
    return image


def draw_wave(draw: ImageDraw.ImageDraw, box: tuple[int, int, int, int], color: tuple[int, int, int, int]) -> None:
    left, top, right, bottom = box
    width = right - left
    height = bottom - top
    points: list[tuple[float, float]] = []
    for idx in range(11):
        x = left + width * idx / 10
        pivot = [0.45, 0.62, 0.25, 0.82, 0.35, 0.62, 0.28, 0.76, 0.41, 0.58, 0.5][idx]
        y = top + height * pivot
        points.append((x, y))
    draw.line(points, fill=color, width=max(4, width // 16), joint="curve")


def render_icon() -> Image.Image:
    size = 512
    base = gradient_background((size, size), "#0f766e", "#2563eb")
    overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
    odraw = ImageDraw.Draw(overlay)

    odraw.rounded_rectangle((32, 32, 480, 480), radius=116, fill=(255, 255, 255, 26), outline=(255, 255, 255, 60), width=4)
    odraw.ellipse((66, 84, 446, 464), fill=(255, 255, 255, 36))
    odraw.ellipse((110, 128, 402, 420), fill=(255, 255, 255, 58))

    base = Image.alpha_composite(base, overlay)
    draw = ImageDraw.Draw(base)

    mic_color = (255, 255, 255, 235)
    accent = (191, 219, 254, 255)
    draw.rounded_rectangle((196, 118, 316, 278), radius=58, fill=mic_color)
    draw.rectangle((236, 258, 276, 348), fill=mic_color)
    draw.rounded_rectangle((174, 344, 338, 372), radius=14, fill=accent)
    draw.arc((142, 128, 370, 348), start=205, end=335, fill=accent, width=14)
    draw.arc((122, 106, 390, 372), start=215, end=325, fill=(255, 255, 255, 88), width=8)

    draw_wave(draw, (86, 348, 426, 436), accent)

    font = load_font(88)
    draw.text((98, 58), "TTS", fill=(255, 255, 255, 240), font=font)

    shadow = base.filter(ImageFilter.GaussianBlur(radius=10))
    out = Image.new("RGBA", base.size, (0, 0, 0, 0))
    out.alpha_composite(shadow, (0, 10))
    out.alpha_composite(base)
    return out


def render_wizard(size: tuple[int, int], title: str, subtitle: str) -> Image.Image:
    background = gradient_background(size, "#0f766e", "#1d4ed8")
    overlay = Image.new("RGBA", size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    width, height = size
    draw.rounded_rectangle((18, 18, width - 18, height - 18), radius=28, fill=(255, 255, 255, 18), outline=(255, 255, 255, 42), width=2)
    draw.ellipse((24, height - 140, width - 24, height + 80), fill=(255, 255, 255, 18))

    icon = render_icon().resize((104, 104), Image.Resampling.LANCZOS)
    overlay.alpha_composite(icon, dest=((width - 104) // 2, 26))

    title_font = load_font(22)
    subtitle_font = load_font(14)
    body_font = load_font(13)
    draw.text((20, 146), title, fill=(255, 255, 255, 240), font=title_font, align="center")
    draw.multiline_text((20, 180), subtitle, fill=(230, 245, 255, 225), font=subtitle_font, spacing=6, align="left")
    draw.multiline_text(
        (20, height - 74),
        "开包即用桌面模式\n自动启动 Web / API / WhisperX / VoxCPM",
        fill=(219, 234, 254, 235),
        font=body_font,
        spacing=5,
    )

    return Image.alpha_composite(background, overlay).convert("RGB")


def main() -> None:
    ROOT.mkdir(parents=True, exist_ok=True)
    icon = render_icon()
    icon.save(ICON_PNG)
    icon.save(ICON_ICO, sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])

    wizard = render_wizard((164, 314), "姜Sir TTS 工作台", "本地 VoxCPM2 + WhisperX\n开包即用桌面启动器")
    wizard.save(WIZARD_BMP)

    small = render_wizard((55, 55), "TTS", "")
    small.save(WIZARD_SMALL_BMP)

    print(f"Generated: {ICON_PNG}")
    print(f"Generated: {ICON_ICO}")
    print(f"Generated: {WIZARD_BMP}")
    print(f"Generated: {WIZARD_SMALL_BMP}")


if __name__ == "__main__":
    main()
