"""Integration tests: the Flask app end to end through its HTTP routes."""

import base64
import json
from http import HTTPStatus
from pathlib import Path

import pytest
from flask.testing import FlaskClient

import app
from tests.conftest import PingRecorder

LEFT_BOARD = "E6614103E71F8D26"
UNKNOWN_BOARD = "0000000000000000"
FRAME_BUFFER_BYTES = 81600

HYMNS = {
    "action": "apply",
    "line1": "Hymn",
    "line2": "123",
    "line3": "Psalm",
    "line4": "23",
    "line5": "",
    "line6": "456",
}


def basic_auth(username: str, password: str) -> dict[str, str]:
    token = base64.b64encode(f"{username}:{password}".encode()).decode()
    return {"Authorization": f"Basic {token}"}


def test_ok(client: FlaskClient):
    assert client.get("/ok").status_code == HTTPStatus.NO_CONTENT


def test_index_renders_with_no_state(client: FlaskClient):
    response = client.get("/")

    assert response.status_code == HTTPStatus.OK
    assert b'name="line1"' in response.data


def test_apply_saves_lines_and_renders_images(client: FlaskClient, workdir: Path):
    response = client.post("/images", data=HYMNS)

    assert response.status_code == HTTPStatus.FOUND
    assert response.headers["Location"] == "/"
    assert json.loads((workdir / "images/lines.json").read_text()) == [
        "Hymn",
        "123",
        "Psalm",
        "23",
        "",
        "456",
    ]
    for image_id in (1, 2, 3):
        assert (workdir / f"images/{image_id}.png").exists()

    page = client.get("/").get_data(as_text=True)
    assert 'value="Psalm"' in page
    assert 'value="456"' in page


def test_clear_blanks_every_line(client: FlaskClient, workdir: Path):
    client.post("/images", data=HYMNS)

    client.post("/images", data={"action": "clear"})

    assert json.loads((workdir / "images/lines.json").read_text()) == [""] * 6


def test_unknown_action_is_rejected(client: FlaskClient):
    response = client.post("/images", data={"action": "explode"})

    assert response.status_code == HTTPStatus.BAD_REQUEST


def test_missing_line_is_rejected(client: FlaskClient):
    response = client.post("/images", data={"action": "apply", "line1": "1"})

    assert response.status_code == HTTPStatus.BAD_REQUEST


def test_image_png_is_generated_on_first_request(client: FlaskClient):
    response = client.get("/images/2.png")

    assert response.status_code == HTTPStatus.OK
    assert response.mimetype == "image/png"


def test_device_gets_frame_buffer_then_not_modified(client: FlaskClient):
    client.post("/images", data=HYMNS)

    first = client.get(f"/images/1?device_id={UNKNOWN_BOARD}&saved_state_writes=3")

    assert first.status_code == HTTPStatus.OK
    assert first.mimetype == "application/octet-stream"
    assert len(first.data) == FRAME_BUFFER_BYTES
    etag = first.headers["Etag"]
    assert len(etag) == 40

    # The firmware can't set headers, so it sends the etag as a query param.
    again = client.get(f"/images/1?device_id={UNKNOWN_BOARD}&etag={etag}")
    assert again.status_code == HTTPStatus.NOT_MODIFIED
    assert again.headers["Etag"] == etag

    via_header = client.get("/images/1", headers={"If-None-Match": etag})
    assert via_header.status_code == HTTPStatus.NOT_MODIFIED


def test_new_hymns_change_the_etag(client: FlaskClient):
    client.post("/images", data=HYMNS)
    before = client.get("/images/1").headers["Etag"]

    client.post("/images", data={**HYMNS, "line2": "124"})
    response = client.get(f"/images/1?etag={before}")

    assert response.status_code == HTTPStatus.OK
    assert response.headers["Etag"] != before


def test_device_fetches_are_tracked(client: FlaskClient, workdir: Path):
    client.get(f"/images/1?device_id={LEFT_BOARD}&saved_state_writes=7")

    devices = json.loads((workdir / "images/devices.json").read_text())
    device = devices[LEFT_BOARD]
    assert device["id"] == LEFT_BOARD
    assert device["saved_state_writes"] == "7"
    assert device["last_seen"]
    assert device["last_updated_at"]

    etag = client.get("/images/1").headers["Etag"]
    first_update = device["last_updated_at"]
    client.get(f"/images/1?device_id={LEFT_BOARD}&etag={etag}")

    devices = json.loads((workdir / "images/devices.json").read_text())
    # A 304 refreshes last_seen but must not look like a screen update.
    assert devices[LEFT_BOARD]["last_updated_at"] == first_update

    page = client.get("/devices").get_data(as_text=True)
    assert "Left Hymn Board" in page
    assert "last seen just now" in page


def test_image_fetch_pings_healthcheck_for_known_board(
    client: FlaskClient, pings: PingRecorder
):
    client.get(f"/images/3?device_id={LEFT_BOARD}")

    assert len(pings.pings) == 1
    assert pings.pings[0].url == app.HEALTHCHECKS_PING_URLS[LEFT_BOARD] + "/log"
    assert pings.pings[0].data == "Updating image 3"


def test_image_fetch_without_device_id_is_not_tracked(
    client: FlaskClient, workdir: Path, pings: PingRecorder
):
    client.get("/images/1")

    assert not (workdir / "images/devices.json").exists()
    assert pings.pings == []


def test_device_booted(client: FlaskClient, workdir: Path, pings: PingRecorder):
    response = client.get(f"/device_booted?device_id={LEFT_BOARD}&saved_state_writes=2")

    assert response.status_code == HTTPStatus.NO_CONTENT
    assert pings.pings[0].url.endswith("/log")
    assert pings.pings[0].data == "Device booted"
    device = json.loads((workdir / "images/devices.json").read_text())[LEFT_BOARD]
    assert device["booted_at"]


def test_watchdog_reboot_reports_failure(client: FlaskClient, pings: PingRecorder):
    client.get(f"/device_booted?device_id={LEFT_BOARD}&watchdog_caused_reboot=1")

    assert pings.pings[0].url == app.HEALTHCHECKS_PING_URLS[LEFT_BOARD] + "/failure"


def test_device_healthy(client: FlaskClient, workdir: Path, pings: PingRecorder):
    response = client.get(f"/device_healthy?device_id={LEFT_BOARD}")

    assert response.status_code == HTTPStatus.NO_CONTENT
    assert pings.pings[0].url == app.HEALTHCHECKS_PING_URLS[LEFT_BOARD]
    assert (workdir / "images/devices.json").exists()


def test_device_report_without_id_is_ignored(
    client: FlaskClient, workdir: Path, pings: PingRecorder
):
    response = client.get("/device_healthy")

    assert response.status_code == HTTPStatus.NO_CONTENT
    assert pings.pings == []
    assert not (workdir / "images/devices.json").exists()


def test_devices_sorted_with_known_boards_in_configured_order(client: FlaskClient):
    right_board = "E661A4D41787452B"
    for board in (right_board, LEFT_BOARD, UNKNOWN_BOARD):
        client.get(f"/device_healthy?device_id={board}")

    ids = [device["id"] for device in app.get_sorted_devices()]

    assert ids == [UNKNOWN_BOARD, LEFT_BOARD, right_board]


def test_healthcheck_failure_does_not_break_the_device(
    client: FlaskClient, monkeypatch: pytest.MonkeyPatch
):
    def fail(*_args: object, **_kwargs: object) -> None:
        raise app.requests.ConnectionError("healthchecks.io is down")

    monkeypatch.setattr(app.requests, "post", fail)

    response = client.get(f"/device_healthy?device_id={LEFT_BOARD}")

    assert response.status_code == HTTPStatus.NO_CONTENT


class TestBasicAuth:
    @pytest.fixture(autouse=True)
    def credentials(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setattr(app, "BASIC_AUTH_USERNAME", "usher")
        monkeypatch.setattr(app, "BASIC_AUTH_PASSWORD", "hosanna")

    @pytest.mark.parametrize("path", ["/", "/devices"])
    def test_admin_pages_require_login(self, client: FlaskClient, path: str):
        response = client.get(path)

        assert response.status_code == HTTPStatus.UNAUTHORIZED
        assert "Basic" in response.headers["WWW-Authenticate"]

    def test_posting_hymns_requires_login(self, client: FlaskClient):
        response = client.post("/images", data=HYMNS)

        assert response.status_code == HTTPStatus.UNAUTHORIZED

    def test_wrong_password_is_rejected(self, client: FlaskClient):
        response = client.get("/", headers=basic_auth("usher", "wrong"))

        assert response.status_code == HTTPStatus.UNAUTHORIZED

    def test_right_password_is_accepted(self, client: FlaskClient):
        response = client.get("/", headers=basic_auth("usher", "hosanna"))

        assert response.status_code == HTTPStatus.OK

    @pytest.mark.parametrize(
        "path", ["/ok", "/images/1", "/images/1.png", "/device_healthy"]
    )
    def test_device_endpoints_stay_open(self, client: FlaskClient, path: str):
        assert client.get(path).status_code < HTTPStatus.BAD_REQUEST
