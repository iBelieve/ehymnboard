"""OTA firmware routes: uploading an image and boards checking for and
downloading it."""

import io
import json
from http import HTTPStatus
from pathlib import Path

import pytest
from flask.testing import FlaskClient

import app
from tests.conftest import PingRecorder

LEFT_BOARD = "E6614103E71F8D26"
IMAGE = bytes(range(256)) * 8


def upload(client: FlaskClient, version: str = "v2", image: bytes | None = IMAGE):
    data: dict[str, object] = {"version": version}
    if image is not None:
        data["image"] = (io.BytesIO(image), "ehymnboard_fota_image_encrypted.bin")
    return client.post("/firmware", data=data)


def test_no_firmware_keeps_board_on_its_version(client: FlaskClient):
    response = client.get(f"/firmware/latest?device_id={LEFT_BOARD}&version=v1")

    assert response.status_code == HTTPStatus.NO_CONTENT


def test_upload_offers_new_version(client: FlaskClient, workdir: Path):
    assert upload(client).status_code == HTTPStatus.CREATED

    response = client.get(f"/firmware/latest?device_id={LEFT_BOARD}&version=v1")

    assert response.status_code == HTTPStatus.OK
    assert response.data == b"v2"
    info = json.loads((workdir / "images/firmware/firmware.json").read_text())
    assert info["version"] == "v2"
    assert info["size"] == len(IMAGE)


def test_board_on_latest_version_is_up_to_date(client: FlaskClient, workdir: Path):
    upload(client)

    response = client.get(f"/firmware/latest?device_id={LEFT_BOARD}&version=v2")

    assert response.status_code == HTTPStatus.NO_CONTENT
    device = json.loads((workdir / "images/devices.json").read_text())[LEFT_BOARD]
    assert device["firmware_version"] == "v2"


def test_image_download(client: FlaskClient, pings: PingRecorder):
    upload(client)

    response = client.get(
        f"/firmware/image?device_id={LEFT_BOARD}&version=v1&target_version=v2"
    )

    assert response.status_code == HTTPStatus.OK
    assert response.data == IMAGE
    assert response.headers["Content-Length"] == str(len(IMAGE))
    assert pings.pings[-1].data == "Downloading firmware v2"


def test_image_for_superseded_version_is_a_conflict(client: FlaskClient):
    upload(client)

    response = client.get(f"/firmware/image?device_id={LEFT_BOARD}&target_version=v1")

    assert response.status_code == HTTPStatus.CONFLICT


def test_image_before_any_upload_is_not_found(client: FlaskClient):
    response = client.get(f"/firmware/image?device_id={LEFT_BOARD}&target_version=v2")

    assert response.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.parametrize(
    ("version", "image"),
    [
        ("", IMAGE),
        ("has spaces", IMAGE),
        ("v" * 48, IMAGE),
        ("v2", None),
        ("v2", b""),
        ("v2", IMAGE[:-1]),
        ("v2", b"\0" * (app.FIRMWARE_MAX_SIZE + 256)),
    ],
)
def test_invalid_upload_is_rejected(
    client: FlaskClient, workdir: Path, version: str, image: bytes | None
):
    response = upload(client, version, image)

    assert response.status_code == HTTPStatus.BAD_REQUEST
    assert not (workdir / "images/firmware/firmware.json").exists()


def test_upload_needs_basic_auth(client: FlaskClient, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(app, "BASIC_AUTH_USERNAME", "user")
    monkeypatch.setattr(app, "BASIC_AUTH_PASSWORD", "pass")

    assert upload(client).status_code == HTTPStatus.UNAUTHORIZED


def test_installed_update_is_logged(
    client: FlaskClient, workdir: Path, pings: PingRecorder
):
    client.get(
        f"/device_booted?device_id={LEFT_BOARD}&watchdog_caused_reboot=1"
        "&firmware_version=v2&ota_status=updated&ota_version=v2"
    )

    # The update reboots through the watchdog, which isn't a failure
    assert [p.url for p in pings.pings] == [
        app.HEALTHCHECKS_PING_URLS[LEFT_BOARD] + "/log"
    ]
    assert pings.pings[0].data == "Installed firmware v2"
    device = json.loads((workdir / "images/devices.json").read_text())[LEFT_BOARD]
    assert device["firmware_version"] == "v2"
    assert device["ota_status"] == "updated"
    assert device["ota_at"]


def test_rollback_is_reported_as_failure(
    client: FlaskClient, workdir: Path, pings: PingRecorder
):
    client.get(
        f"/device_booted?device_id={LEFT_BOARD}&watchdog_caused_reboot=1"
        "&firmware_version=v1&ota_status=rolled_back&ota_version=v2"
    )

    assert [p.url for p in pings.pings] == [
        app.HEALTHCHECKS_PING_URLS[LEFT_BOARD] + "/failure"
    ]
    assert pings.pings[0].data == "Firmware v2 failed and was rolled back"
    device = json.loads((workdir / "images/devices.json").read_text())[LEFT_BOARD]
    assert device["ota_status"] == "rolled_back"
    assert device["ota_version"] == "v2"


def test_unknown_ota_status_is_ignored(client: FlaskClient, workdir: Path):
    client.get(f"/device_booted?device_id={LEFT_BOARD}&ota_status=bogus")

    device = json.loads((workdir / "images/devices.json").read_text())[LEFT_BOARD]
    assert "ota_status" not in device


@pytest.mark.parametrize("version", ["", "&ota_version=", "&ota_version=a/b"])
def test_ota_status_without_a_valid_version_is_a_plain_boot(
    client: FlaskClient, workdir: Path, pings: PingRecorder, version: str
):
    client.get(f"/device_booted?device_id={LEFT_BOARD}&ota_status=rolled_back{version}")

    assert pings.pings[0].data == "Device booted"
    device = json.loads((workdir / "images/devices.json").read_text())[LEFT_BOARD]
    assert "ota_status" not in device


def test_devices_page_shows_firmware(client: FlaskClient):
    upload(client)
    client.get(
        f"/device_booted?device_id={LEFT_BOARD}"
        "&firmware_version=v1&ota_status=rolled_back&ota_version=v2"
    )

    page = client.get("/devices").data.decode()

    assert "firmware v1" in page
    assert "rolled back v2" in page
    assert "Latest firmware v2" in page
