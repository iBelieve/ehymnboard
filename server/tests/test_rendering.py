"""Unit and property tests for turning hymn numbers into e-ink frame buffers."""

import string

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st
from PIL import Image, ImageDraw

import app

# The device firmware expects exactly this many bytes per screen (see
# device/src/fetch_image.h), one bit per pixel.
FRAME_BUFFER_BYTES = 81600

# Hymn boards show hymn numbers, liturgical abbreviations and short words, all
# of which Bebas Neue has glyphs for.
board_text = st.text(
    alphabet=string.ascii_letters + string.digits + " -.:,;'&()/#",
    max_size=40,
)

# Rendering text at every font size is slow, so keep the example count modest.
render_settings = settings(
    max_examples=40, deadline=None, suppress_health_check=[HealthCheck.too_slow]
)


def unpack(buffer: bytes, width: int, height: int) -> list[list[bool]]:
    """Inverse of image_to_buffer: MSB-first, row-major, one bit per pixel."""
    return [
        [
            bool(buffer[(x + y * width) // 8] & (0b1000_0000 >> (x % 8)))
            for x in range(width)
        ]
        for y in range(height)
    ]


def test_screen_buffer_size_matches_firmware():
    image = Image.new("1", (app.SCREEN_WIDTH, app.SCREEN_HEIGHT), 0)
    assert len(app.image_to_buffer(image)) == FRAME_BUFFER_BYTES


def test_image_to_buffer_packs_msb_first():
    image = Image.new("1", (16, 1), 0)
    image.putpixel((0, 0), 1)
    image.putpixel((9, 0), 1)
    image.putpixel((15, 0), 1)

    assert app.image_to_buffer(image) == bytes([0b1000_0000, 0b0100_0001])


@given(
    width_bytes=st.integers(min_value=1, max_value=8),
    height=st.integers(min_value=1, max_value=8),
    data=st.data(),
)
def test_image_to_buffer_round_trips(
    width_bytes: int, height: int, data: st.DataObject
):
    width = width_bytes * 8
    pixels = data.draw(
        st.lists(st.booleans(), min_size=width * height, max_size=width * height)
    )
    image = Image.new("1", (width, height), 0)
    image.putdata([255 if p else 0 for p in pixels])

    buffer = app.image_to_buffer(image)

    assert len(buffer) == width * height // 8
    flat = [bit for row in unpack(buffer, width, height) for bit in row]
    assert flat == pixels


def test_calculate_font_size_empty_text_has_no_font():
    draw = ImageDraw.Draw(Image.new("1", (1, 1)))
    assert app.calculate_font_size(draw, "", app.FONT_NAME) is None


@render_settings
@given(text=board_text.filter(str.strip))
def test_calculated_font_fits_on_screen(text: str):
    draw = ImageDraw.Draw(Image.new("1", (app.SCREEN_WIDTH, app.SCREEN_HEIGHT)))

    font = app.calculate_font_size(draw, text, app.FONT_NAME)

    assert font is not None
    assert 1 <= font.size <= app.MAX_FONT_SIZE
    assert draw.textlength(text, font=font) <= app.MAX_LINE_WIDTH


def test_calculate_font_size_never_shrinks_to_zero():
    """Text too wide even at 1pt must still render (clipped), not crash."""
    draw = ImageDraw.Draw(Image.new("1", (1, 1)))

    font = app.calculate_font_size(draw, "W" * 5000, app.FONT_NAME)

    assert font is not None
    assert font.size == 1


def test_short_text_is_capped_at_max_font_size():
    draw = ImageDraw.Draw(Image.new("1", (1, 1)))

    font = app.calculate_font_size(draw, "1", app.FONT_NAME)

    assert font is not None
    assert app.MAX_FONT_SIZE - 1 <= font.size <= app.MAX_FONT_SIZE


def test_generate_image_blank_lines_is_all_black(workdir):
    app.generate_image("1", "", "")

    image = Image.open(workdir / "images/1.png")
    assert image.size == (app.SCREEN_WIDTH, app.SCREEN_HEIGHT)
    assert image.getbbox() is None


@render_settings
@given(line1=board_text, line2=board_text)
def test_generated_text_stays_inside_its_half(line1: str, line2: str):
    app.generate_image("p", line1, line2)

    image = Image.open("images/p.png")
    assert image.size == (app.SCREEN_WIDTH, app.SCREEN_HEIGHT)

    top = image.crop((0, 0, app.SCREEN_WIDTH, app.SCREEN_HEIGHT // 2)).getbbox()
    bottom = image.crop(
        (0, app.SCREEN_HEIGHT // 2, app.SCREEN_WIDTH, app.SCREEN_HEIGHT)
    ).getbbox()
    assert (top is not None) == bool(line1.strip())
    assert (bottom is not None) == bool(line2.strip())


@render_settings
@given(line1=st.text(max_size=20), line2=st.text(max_size=20))
def test_any_unicode_renders_without_crashing(line1: str, line2: str):
    app.generate_image("u", line1, line2)

    assert len(app.image_to_buffer(Image.open("images/u.png"))) == FRAME_BUFFER_BYTES


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("  Hymn   123 ", "Hymn 123"),
        ("Hymn\n123", "Hymn 123"),
        ("Hymn\r\n123", "Hymn 123"),
        ("1\x002\x1b3", "123"),
        ("", ""),
    ],
)
def test_clean_line(raw: str, expected: str):
    assert app.clean_line(raw) == expected
