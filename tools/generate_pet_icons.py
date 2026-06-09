"""
Generate 256×256 kawaii-style pet icons for DanceMonkey desktop pet mode.
Each icon has a transparent background with soft shadows, big sparkly eyes,
rosy cheeks, and a cute overall aesthetic suitable for production use.

The final output is saved at 128×128 with LANCZOS downsampling for crisp edges.
"""
from PIL import Image, ImageDraw, ImageFilter
import math, os

OUT_DIR = os.path.join(os.path.dirname(__file__), '..', 'Resources', 'PetIcons')
os.makedirs(OUT_DIR, exist_ok=True)

# Work at 2× then downsample for anti-aliased result
WORK = 512
FINAL = 128


# ── helpers ──────────────────────────────────────────────────────────────────

def canvas():
    return Image.new('RGBA', (WORK, WORK), (0, 0, 0, 0))


def soft_ellipse(img, bbox, fill, blur=6):
    """Draw an ellipse with a soft (blurred) edge for a plush look."""
    layer = Image.new('RGBA', img.size, (0, 0, 0, 0))
    ImageDraw.Draw(layer).ellipse(bbox, fill=fill)
    layer = layer.filter(ImageFilter.GaussianBlur(blur))
    return Image.alpha_composite(img, layer)


def draw_ellipse(d, bbox, fill, outline=None, width=0):
    d.ellipse(bbox, fill=fill, outline=outline, width=width)


def draw_eye(d, cx, cy, r=28, highlight=True):
    """Kawaii-style big eye with double highlight."""
    # Outer eye (dark)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(30, 30, 30))
    # Iris ring
    ir = int(r * 0.82)
    d.ellipse([cx - ir, cy - ir, cx + ir, cy + ir], fill=(50, 50, 60))
    if highlight:
        # Big highlight (top-right)
        hr = int(r * 0.38)
        hx, hy = cx + int(r * 0.22), cy - int(r * 0.28)
        d.ellipse([hx - hr, hy - hr, hx + hr, hy + hr], fill=(255, 255, 255))
        # Small highlight (bottom-left)
        sr = int(r * 0.16)
        sx, sy = cx - int(r * 0.22), cy + int(r * 0.18)
        d.ellipse([sx - sr, sy - sr, sx + sr, sy + sr], fill=(255, 255, 255))


def draw_blush(d, cx, cy, rx=22, ry=14):
    """Soft rosy cheek."""
    d.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=(255, 160, 160, 90))


def draw_shadow(img, bbox, offset=8, blur=12):
    """Subtle drop shadow under the character."""
    shadow = Image.new('RGBA', img.size, (0, 0, 0, 0))
    sb = [bbox[0] + offset, bbox[1] + offset, bbox[2] + offset, bbox[3] + offset]
    ImageDraw.Draw(shadow).ellipse(sb, fill=(0, 0, 0, 40))
    shadow = shadow.filter(ImageFilter.GaussianBlur(blur))
    return Image.alpha_composite(shadow, img)


def add_ground_shadow(img, cx=256, cy=440, rx=100, ry=18):
    """Elliptical ground shadow beneath the pet."""
    shadow = Image.new('RGBA', img.size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=(0, 0, 0, 30))
    shadow = shadow.filter(ImageFilter.GaussianBlur(10))
    return Image.alpha_composite(shadow, img)


def finalize(img, name):
    """Add ground shadow, downsample, and save."""
    img = add_ground_shadow(img)
    img = img.resize((FINAL, FINAL), Image.LANCZOS)
    img.save(os.path.join(OUT_DIR, name))
    print(f"  ✔ {name}")


def rounded_rect(d, bbox, radius, fill, outline=None, width=0):
    d.rounded_rectangle(bbox, radius=radius, fill=fill, outline=outline, width=width)


# ── Cat ──────────────────────────────────────────────────────────────────────

def draw_cat():
    img = canvas()
    d = ImageDraw.Draw(img)

    body_color = (255, 190, 120)
    body_dark = (230, 160, 90)
    body_light = (255, 215, 170)

    # Tail (behind body)
    d.arc([340, 200, 480, 380], 220, 20, fill=body_dark, width=20)
    d.arc([360, 220, 500, 360], 220, 20, fill=body_color, width=14)

    # Body
    d.ellipse([140, 220, 380, 420], fill=body_color, outline=body_dark, width=4)
    # Belly highlight
    d.ellipse([180, 270, 340, 400], fill=body_light)

    # Head
    d.ellipse([130, 80, 390, 300], fill=body_color, outline=body_dark, width=4)

    # Left ear
    d.polygon([(145, 140), (170, 40), (220, 130)], fill=body_color, outline=body_dark)
    d.polygon([(160, 130), (172, 58), (210, 125)], fill=(255, 180, 190))
    # Right ear
    d.polygon([(300, 130), (350, 40), (375, 140)], fill=body_color, outline=body_dark)
    d.polygon([(310, 125), (348, 58), (360, 130)], fill=(255, 180, 190))

    # Eyes
    draw_eye(d, 210, 185, r=26)
    draw_eye(d, 310, 185, r=26)

    # Nose (small triangle)
    d.polygon([(252, 220), (268, 220), (260, 232)], fill=(255, 130, 150))

    # Mouth
    d.arc([240, 228, 260, 248], 0, 180, fill=(180, 100, 80), width=3)
    d.arc([260, 228, 280, 248], 0, 180, fill=(180, 100, 80), width=3)

    # Whiskers
    for dy in (-4, 4):
        d.line([(200, 230 + dy), (120, 220 + dy * 2)], fill=(200, 140, 80), width=2)
        d.line([(320, 230 + dy), (400, 220 + dy * 2)], fill=(200, 140, 80), width=2)

    # Blush
    draw_blush(d, 180, 225, 20, 12)
    draw_blush(d, 340, 225, 20, 12)

    # Paws
    d.ellipse([155, 370, 215, 420], fill=body_light, outline=body_dark, width=3)
    d.ellipse([305, 370, 365, 420], fill=body_light, outline=body_dark, width=3)
    # Paw pads
    for px in (175, 195):
        d.ellipse([px - 6, 390, px + 6, 404], fill=(255, 180, 190))
    for px in (325, 345):
        d.ellipse([px - 6, 390, px + 6, 404], fill=(255, 180, 190))

    finalize(img, 'pet_cat.png')


# ── Dog ──────────────────────────────────────────────────────────────────────

def draw_dog():
    img = canvas()
    d = ImageDraw.Draw(img)

    body_color = (220, 180, 140)
    body_dark = (180, 140, 100)
    body_light = (245, 225, 200)

    # Tail (wagging, behind body)
    d.arc([350, 180, 490, 340], 250, 40, fill=body_dark, width=18)

    # Body
    d.ellipse([130, 230, 390, 430], fill=body_color, outline=body_dark, width=4)
    d.ellipse([170, 280, 350, 410], fill=body_light)

    # Head
    d.ellipse([125, 75, 395, 305], fill=body_color, outline=body_dark, width=4)

    # Floppy ears
    d.ellipse([90, 120, 175, 270], fill=(195, 155, 115), outline=body_dark, width=3)
    d.ellipse([345, 120, 430, 270], fill=(195, 155, 115), outline=body_dark, width=3)

    # Muzzle
    d.ellipse([200, 195, 320, 280], fill=body_light, outline=(210, 185, 160), width=2)

    # Eyes
    draw_eye(d, 205, 170, r=24)
    draw_eye(d, 315, 170, r=24)

    # Eyebrows (friendly)
    d.arc([180, 138, 230, 162], 200, 340, fill=body_dark, width=5)
    d.arc([290, 138, 340, 162], 200, 340, fill=body_dark, width=5)

    # Nose
    d.ellipse([240, 210, 280, 242], fill=(50, 40, 40))
    d.ellipse([248, 215, 265, 230], fill=(90, 80, 80))

    # Tongue
    d.ellipse([245, 252, 275, 290], fill=(255, 130, 150))
    d.rectangle([245, 248, 275, 268], fill=body_light)

    # Mouth
    d.arc([225, 240, 260, 260], 0, 180, fill=(140, 90, 60), width=2)
    d.arc([260, 240, 295, 260], 0, 180, fill=(140, 90, 60), width=2)

    # Blush
    draw_blush(d, 175, 220, 18, 12)
    draw_blush(d, 345, 220, 18, 12)

    # Collar
    d.arc([165, 275, 355, 330], 10, 170, fill=(230, 60, 60), width=10)
    # Tag
    d.ellipse([248, 318, 272, 342], fill=(255, 220, 50), outline=(220, 180, 30), width=2)

    # Paws
    d.ellipse([150, 380, 215, 430], fill=body_light, outline=body_dark, width=3)
    d.ellipse([305, 380, 370, 430], fill=body_light, outline=body_dark, width=3)

    finalize(img, 'pet_dog.png')


# ── Rabbit ───────────────────────────────────────────────────────────────────

def draw_rabbit():
    img = canvas()
    d = ImageDraw.Draw(img)

    body_color = (250, 248, 250)
    body_dark = (210, 205, 215)
    body_pink = (255, 200, 210)

    # Tail (fluffy pom behind)
    d.ellipse([340, 340, 410, 400], fill=(255, 255, 255), outline=body_dark, width=2)

    # Body
    d.ellipse([145, 240, 375, 430], fill=body_color, outline=body_dark, width=4)
    d.ellipse([180, 290, 340, 415], fill=(255, 252, 255))

    # Head
    d.ellipse([140, 100, 380, 300], fill=body_color, outline=body_dark, width=4)

    # Left ear
    d.rounded_rectangle([175, 0, 220, 140], radius=22, fill=body_color, outline=body_dark, width=3)
    d.rounded_rectangle([183, 12, 212, 125], radius=16, fill=body_pink)
    # Right ear (slightly tilted via offset)
    d.rounded_rectangle([300, 0, 345, 140], radius=22, fill=body_color, outline=body_dark, width=3)
    d.rounded_rectangle([308, 12, 337, 125], radius=16, fill=body_pink)

    # Eyes
    draw_eye(d, 210, 195, r=24)
    draw_eye(d, 310, 195, r=24)

    # Nose
    d.ellipse([247, 228, 273, 248], fill=(255, 150, 170))

    # Mouth (Y shape)
    d.line([(260, 248), (260, 262)], fill=(200, 140, 140), width=3)
    d.arc([238, 256, 260, 276], 0, 180, fill=(200, 140, 140), width=2)
    d.arc([260, 256, 282, 276], 0, 180, fill=(200, 140, 140), width=2)

    # Blush
    draw_blush(d, 175, 235, 22, 14)
    draw_blush(d, 345, 235, 22, 14)

    # Paws
    d.ellipse([160, 380, 225, 430], fill=body_color, outline=body_dark, width=3)
    d.ellipse([295, 380, 360, 430], fill=body_color, outline=body_dark, width=3)
    # Paw pads
    d.ellipse([182, 400, 202, 416], fill=body_pink)
    d.ellipse([318, 400, 338, 416], fill=body_pink)

    # Small bow on ear
    d.polygon([(215, 80), (230, 95), (215, 110)], fill=(255, 120, 150))
    d.polygon([(215, 80), (200, 95), (215, 110)], fill=(255, 140, 165))
    d.ellipse([210, 90, 220, 100], fill=(255, 100, 130))

    finalize(img, 'pet_rabbit.png')


# ── Fox ──────────────────────────────────────────────────────────────────────

def draw_fox():
    img = canvas()
    d = ImageDraw.Draw(img)

    body_color = (240, 130, 50)
    body_dark = (200, 95, 30)
    body_white = (255, 245, 230)

    # Big fluffy tail (behind body)
    d.ellipse([330, 200, 500, 380], fill=body_color, outline=body_dark, width=4)
    d.ellipse([370, 300, 480, 375], fill=body_white)

    # Body
    d.ellipse([130, 230, 380, 425], fill=body_color, outline=body_dark, width=4)
    # White belly
    d.ellipse([170, 290, 340, 415], fill=body_white)

    # Head
    d.ellipse([125, 80, 395, 300], fill=body_color, outline=body_dark, width=4)
    # White face
    d.ellipse([185, 180, 335, 290], fill=body_white)

    # Ears (pointed with dark tips)
    d.polygon([(140, 135), (175, 30), (225, 125)], fill=body_color, outline=body_dark)
    d.polygon([(155, 120), (176, 48), (210, 115)], fill=(50, 45, 40))
    d.polygon([(295, 125), (345, 30), (380, 135)], fill=body_color, outline=body_dark)
    d.polygon([(310, 115), (344, 48), (365, 120)], fill=(50, 45, 40))

    # Eyes (slightly narrower, foxy)
    draw_eye(d, 210, 185, r=22)
    draw_eye(d, 310, 185, r=22)

    # Nose
    d.ellipse([245, 215, 275, 240], fill=(50, 40, 40))
    d.ellipse([252, 220, 266, 232], fill=(85, 75, 75))

    # Mouth
    d.arc([235, 238, 260, 258], 0, 180, fill=(140, 80, 40), width=2)
    d.arc([260, 238, 285, 258], 0, 180, fill=(140, 80, 40), width=2)

    # Blush
    draw_blush(d, 178, 225, 18, 12)
    draw_blush(d, 342, 225, 18, 12)

    # Paws (dark socks)
    d.ellipse([148, 375, 215, 425], fill=(70, 50, 30), outline=(50, 35, 20), width=3)
    d.ellipse([305, 375, 372, 425], fill=(70, 50, 30), outline=(50, 35, 20), width=3)

    # Chest tuft
    d.polygon([(230, 260), (260, 240), (290, 260), (270, 290), (250, 290)], fill=body_white)

    finalize(img, 'pet_fox.png')


# ── Human (cute chibi assistant) ────────────────────────────────────────────

def draw_human():
    img = canvas()
    d = ImageDraw.Draw(img)

    skin = (255, 225, 195)
    skin_dark = (240, 200, 170)
    hair = (70, 50, 40)
    shirt = (110, 150, 240)
    shirt_dark = (85, 120, 210)

    # ── Legs ──
    d.rounded_rectangle([195, 370, 235, 430], radius=10, fill=(70, 80, 120))
    d.rounded_rectangle([285, 370, 325, 430], radius=10, fill=(70, 80, 120))
    # Shoes
    d.ellipse([188, 415, 242, 445], fill=(80, 80, 90), outline=(60, 60, 70), width=2)
    d.ellipse([278, 415, 332, 445], fill=(80, 80, 90), outline=(60, 60, 70), width=2)

    # ── Body (shirt) ──
    d.rounded_rectangle([170, 260, 350, 390], radius=24, fill=shirt, outline=shirt_dark, width=4)
    # Collar V
    d.polygon([(235, 260), (260, 300), (285, 260)], fill=(95, 130, 220))

    # ── Arms ──
    d.rounded_rectangle([120, 270, 175, 360], radius=18, fill=shirt, outline=shirt_dark, width=3)
    d.rounded_rectangle([345, 270, 400, 360], radius=18, fill=shirt, outline=shirt_dark, width=3)
    # Hands
    d.ellipse([118, 340, 162, 380], fill=skin, outline=skin_dark, width=2)
    d.ellipse([358, 340, 402, 380], fill=skin, outline=skin_dark, width=2)

    # Waving hand (right) - small star sparkle
    d.polygon([(405, 330), (415, 340), (405, 350), (395, 340)], fill=(255, 230, 100))
    d.polygon([(410, 320), (415, 340), (420, 320), (415, 315)], fill=(255, 230, 100))

    # ── Head ──
    d.ellipse([165, 70, 355, 260], fill=skin, outline=skin_dark, width=4)

    # ── Hair ──
    # Back hair
    d.ellipse([155, 55, 365, 190], fill=hair)
    # Bangs
    d.arc([165, 60, 260, 150], 200, 360, fill=hair, width=30)
    d.arc([250, 60, 355, 150], 180, 340, fill=hair, width=30)
    # Side hair
    d.ellipse([155, 100, 195, 200], fill=hair)
    d.ellipse([325, 100, 365, 200], fill=hair)
    # Hair highlight
    d.arc([200, 65, 300, 120], 200, 340, fill=(100, 75, 60), width=6)

    # ── Face ──
    # Eyes
    draw_eye(d, 220, 175, r=22)
    draw_eye(d, 300, 175, r=22)

    # Eyebrows
    d.arc([196, 142, 244, 166], 200, 340, fill=hair, width=5)
    d.arc([276, 142, 324, 166], 200, 340, fill=hair, width=5)

    # Mouth (happy smile)
    d.arc([232, 210, 288, 240], 10, 170, fill=(220, 120, 100), width=4)

    # Blush
    draw_blush(d, 190, 210, 18, 12)
    draw_blush(d, 330, 210, 18, 12)

    # ── Pocket detail on shirt ──
    d.rounded_rectangle([235, 330, 285, 365], radius=8, fill=shirt_dark, outline=(75, 105, 195), width=2)

    finalize(img, 'pet_human.png')


# ── Main ─────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    print("Generating kawaii pet icons (512→128 LANCZOS)...")
    draw_cat()
    draw_dog()
    draw_rabbit()
    draw_fox()
    draw_human()
    print(f"\nAll 5 pet icons saved to: {os.path.abspath(OUT_DIR)}")
