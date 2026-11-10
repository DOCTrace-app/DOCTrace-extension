"""
Generate fake screenshot-like PNG files for the Group 2 tests.

All text in these images is FAKE.
Run from the project root:

    python testdata/generate_testdata.py

Images are drawn at a large scale so they look like a dpr=2 screenshot.
"""
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent
FONT_PATHS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "C:/Windows/Fonts/arial.ttf",
    "/Library/Fonts/Arial.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
]


def font(size):
    for p in FONT_PATHS:
        if Path(p).exists():
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


F = font(30)
FB = font(38)
FS = font(26)
DARK = (20, 20, 20)


def canvas(w=1600, h=1000):
    img = Image.new("RGB", (w, h), (246, 247, 250))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, w, 90], fill=(38, 70, 140))
    d.text((40, 24), "Scribe Demo App", font=FB, fill=(255, 255, 255))
    d.rectangle([0, 90, 300, h], fill=(230, 233, 240))
    for i, item in enumerate(["Home", "Reports", "Settings", "Help"]):
        d.text((40, 130 + i * 70), item, font=F, fill=(40, 40, 40))
    return img, d


def input_box(d, x, y, w, text):
    d.rectangle([x, y, x + w, y + 64], fill=(255, 255, 255), outline=(150, 150, 160), width=2)
    d.text((x + 16, y + 14), text, font=F, fill=DARK)


def save(img, name):
    img.save(OUT / name)
    print("wrote", name)


def main():
    # 1 and 7: normal UI. Nothing here should be masked.
    img, d = canvas()
    d.text((360, 130), "Welcome to Dashboard", font=FB, fill=DARK)
    d.text((360, 220), "Total Sales: $10000", font=F, fill=DARK)
    d.text((360, 290), "Orders this week: 128", font=F, fill=DARK)
    d.text((360, 360), "Last updated 12/05/2024 at 10:30 AM", font=F, fill=DARK)
    d.rectangle([360, 450, 560, 520], fill=(38, 70, 140))
    d.text((420, 466), "Login", font=F, fill=(255, 255, 255))
    d.text((360, 580), "Click Settings to change your preferences.", font=F, fill=DARK)
    save(img, "01_normal_ui.png")

    # 2: email
    img, d = canvas()
    d.text((360, 130), "User Profile", font=FB, fill=DARK)
    d.text((360, 230), "Contact: maryam@example.com", font=F, fill=DARK)
    d.text((360, 300), "Team: Quality Assurance", font=F, fill=DARK)
    save(img, "02_email.png")

    # 3: phone
    img, d = canvas()
    d.text((360, 130), "Customer Details", font=FB, fill=DARK)
    d.text((360, 230), "Mobile: 03001234567", font=F, fill=DARK)
    d.text((360, 300), "Office: +92 42 1234 5678", font=F, fill=DARK)
    d.text((360, 370), "Status: Active", font=F, fill=DARK)
    save(img, "03_phone.png")

    # 4: CNIC
    img, d = canvas()
    d.text((360, 130), "Registration Form", font=FB, fill=DARK)
    d.text((360, 230), "CNIC: 35202-1234567-8", font=F, fill=DARK)
    d.text((360, 300), "City: Lahore", font=F, fill=DARK)
    save(img, "04_cnic.png")

    # 5: password (inline value + form field with the label above it)
    img, d = canvas()
    d.text((360, 120), "Sign in to your account", font=FB, fill=DARK)
    d.text((360, 200), "Username", font=FS, fill=(60, 60, 60))
    input_box(d, 360, 240, 600, "demo_user")
    d.text((360, 340), "Password", font=FS, fill=(60, 60, 60))
    input_box(d, 360, 380, 600, "\u2022" * 10)
    d.text((360, 500), "Password: ********", font=F, fill=DARK)
    d.text((360, 580), "Forgot password?", font=FS, fill=(38, 70, 140))
    save(img, "05_password.png")

    # 6: API key
    img, d = canvas()
    d.text((360, 130), "Developer Settings", font=FB, fill=DARK)
    d.text((360, 230), "API_KEY: ABC123XYZ", font=F, fill=DARK)
    d.text((360, 300), "Token: sk_test_4eC39HqLyjWDarjtT1zdp7dc", font=F, fill=DARK)
    d.text((360, 370), "Environment: staging", font=F, fill=DARK)
    save(img, "06_api_key.png")

    # Mixed screen for the demo
    img, d = canvas()
    d.text((360, 120), "Account Settings", font=FB, fill=DARK)
    d.text((360, 200), "Email: ali.raza@example.org", font=F, fill=DARK)
    d.text((360, 260), "Phone: 0321-7654321", font=F, fill=DARK)
    d.text((360, 320), "CNIC: 42101-7654321-3", font=F, fill=DARK)
    d.text((360, 380), "Password: ********", font=F, fill=DARK)
    d.text((360, 440), "API_KEY: ABC123XYZ", font=F, fill=DARK)
    d.text((360, 520), "Language: English", font=F, fill=DARK)
    d.text((360, 580), "Theme: Light", font=F, fill=DARK)
    save(img, "07_mixed_settings.png")

    # Same screen at half size, like a dpr=1 screenshot (small text).
    # Tests the 2x upscale path before OCR.
    small = img.resize((img.width // 2, img.height // 2), Image.LANCZOS)
    save(small, "09_mixed_dpr1.png")

    # 8: corrupt file, used to test the OCR failure path
    (OUT / "08_corrupt.png").write_bytes(b"this is not a real PNG image")
    print("wrote 08_corrupt.png")

    cases = [
        {"id": 1, "name": "Normal screenshot: text extracted", "file": "01_normal_ui.png",
         "expectStatus": "redacted", "expectText": ["Dashboard", "Settings"]},
        {"id": 2, "name": "Fake email detected and masked", "file": "02_email.png",
         "expectStatus": "redacted", "expectTypes": ["email"]},
        {"id": 3, "name": "Fake phone detected and masked", "file": "03_phone.png",
         "expectStatus": "redacted", "expectTypes": ["phone"]},
        {"id": 4, "name": "Fake CNIC detected and masked", "file": "04_cnic.png",
         "expectStatus": "redacted", "expectTypes": ["cnic"]},
        {"id": 5, "name": "Password: ******** detected by keyword + spatial context", "file": "05_password.png",
         "expectStatus": "redacted", "expectTypes": ["password"], "minRegions": 2},
        {"id": 6, "name": "API_KEY: ABC123XYZ detected and masked", "file": "06_api_key.png",
         "expectStatus": "redacted", "expectTypes": ["api_key"]},
        {"id": 7, "name": "Normal UI text is not masked", "file": "01_normal_ui.png",
         "expectStatus": "redacted", "maxRegions": 0},
        {"id": 8, "name": "OCR failure gives status failed", "file": "08_corrupt.png",
         "expectStatus": "failed"},
        {"id": 9, "name": "Mixed settings screen (demo)", "file": "07_mixed_settings.png",
         "expectStatus": "redacted", "expectTypes": ["email", "phone", "cnic", "password", "api_key"]},
        {"id": 10, "name": "Low resolution dpr=1 screenshot (2x OCR upscale)", "file": "09_mixed_dpr1.png",
         "dpr": 1, "expectStatus": "redacted", "expectTypes": ["email", "phone", "cnic", "password", "api_key"]},
    ]
    (OUT / "cases.json").write_text(json.dumps(cases, indent=2))
    print("wrote cases.json")


if __name__ == "__main__":
    main()
