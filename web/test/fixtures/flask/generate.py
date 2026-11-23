"""Regenerates the Flask rendering fixtures for test/render.test.ts.

Run from server/ in a checkout of commit 02ece7f, the last with the Flask
server (it imports app.py):

    uv run python ../web/test/fixtures/flask/generate.py
"""

import gzip
import json
import os
import sys
import tempfile

from PIL import Image, ImageDraw

sys.path.insert(0, os.getcwd())
import app  # noqa: E402

CASES = [
    ["657", "LSB 657"],
    ["123", ""],
    ["", "PSALM 23"],
    ["1-4, 7", "LSB 708"],
    ["A", "WWWWWWWWWWWWWWWWWWWW"],
    ["Introit", "Gradual"],
    ["H", "Kyrie"],
    ["2:18", "1 Cor 13:4-7"],
]

out_dir = os.path.dirname(os.path.abspath(__file__))
app.FONT_NAME = os.path.abspath(app.FONT_NAME)
cases = []

with tempfile.TemporaryDirectory() as tmp:
    os.chdir(tmp)
    for i, (line1, line2) in enumerate(CASES):
        app.generate_image(f"case{i}", line1, line2)
        image = Image.open(f"images/case{i}.png")
        with gzip.open(os.path.join(out_dir, f"case{i}.bin.gz"), "wb") as f:
            f.write(app.image_to_buffer(image))

        draw = ImageDraw.Draw(image)
        sizes = [
            app.calculate_font_size(draw, line, app.FONT_NAME) if line else None
            for line in (line1, line2)
        ]
        cases.append(
            {"lines": [line1, line2], "sizes": [s.size if s else None for s in sizes]}
        )

with open(os.path.join(out_dir, "cases.json"), "w") as f:
    json.dump(cases, f, indent=1)
    f.write("\n")
