"""An usher posts the hymns, then a board picks them up."""

import re

import pytest
from playwright.sync_api import APIRequestContext, Page, expect

BOARD_ID = "E2E0000000000001"
FRAME_BUFFER_BYTES = 81600

HYMNS = ["Hymn", "123", "Psalm", "23", "Offertory", "456"]


@pytest.fixture
def board(playwright, base_url: str):
    """An HTTP client that behaves like the firmware: no auth, query params."""
    context = playwright.request.new_context(base_url=base_url)
    yield context
    context.dispose()


def line_inputs(page: Page):
    return [page.locator(f'input[name="line{n}"]') for n in range(1, 7)]


def post_hymns(page: Page, lines: list[str]) -> None:
    page.goto("/")
    for field, value in zip(line_inputs(page), lines, strict=True):
        field.fill(value)
    page.get_by_role("button", name="Apply").click()
    expect(page).to_have_url(re.compile(r"/$"))


def test_server_is_up(board: APIRequestContext):
    assert board.get("/ok").status == 204


def test_usher_sets_hymns_and_board_picks_them_up(page: Page, board: APIRequestContext):
    post_hymns(page, HYMNS)

    # The form keeps what was posted...
    for field, value in zip(line_inputs(page), HYMNS, strict=True):
        expect(field).to_have_value(value)

    # ...and the preview shows the rendered screens.
    for image_id in (1, 2, 3):
        png = page.request.get(f"/images/{image_id}.png")
        assert png.ok
        assert png.headers["content-type"] == "image/png"

    # A board fetches screen 1 like the firmware does.
    response = board.get(f"/images/1?device_id={BOARD_ID}&saved_state_writes=1")
    assert response.status == 200
    assert len(response.body()) == FRAME_BUFFER_BYTES
    etag = response.headers["etag"]

    # Nothing changed, so the next poll is a cheap 304.
    again = board.get(f"/images/1?device_id={BOARD_ID}&etag={etag}")
    assert again.status == 304

    # New hymns mean a new image for the board.
    post_hymns(page, [*HYMNS[:1], "124", *HYMNS[2:]])
    changed = board.get(f"/images/1?device_id={BOARD_ID}&etag={etag}")
    assert changed.status == 200
    assert changed.headers["etag"] != etag


def test_board_check_ins_show_on_admin_page(page: Page, board: APIRequestContext):
    assert board.get(f"/device_booted?device_id={BOARD_ID}").status == 204
    assert board.get(f"/device_healthy?device_id={BOARD_ID}").status == 204

    page.goto("/")

    expect(
        page.get_by_text(re.compile(rf"{BOARD_ID} \(last seen just now"))
    ).to_be_visible()
    expect(page.get_by_text(re.compile(r"booted just now"))).to_be_visible()


def test_clear_blanks_the_boards(page: Page, board: APIRequestContext):
    post_hymns(page, HYMNS)

    page.get_by_role("button", name="Clear").click()

    for field in line_inputs(page):
        expect(field).to_have_value("")
    blank = board.get("/images/2")
    assert blank.ok
    assert not any(blank.body())


def test_admin_requires_login(base_url: str, playwright, credentials):
    if not credentials:
        pytest.skip("server has no basic auth configured")

    anonymous = playwright.request.new_context(base_url=base_url)
    try:
        assert anonymous.get("/").status == 401
        assert anonymous.post("/images", form={"action": "clear"}).status == 401
    finally:
        anonymous.dispose()
