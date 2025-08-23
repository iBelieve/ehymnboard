# eHymnBoard web app and backend server
# Copyright (C) 2025  Michael Spencer <sonrisesoftware@gmail.com>
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as
# published by the Free Software Foundation, either version 3 of the
# License, or (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.

from functools import wraps
from flask import (
    Flask,
    Response,
    request,
    make_response,
    render_template,
    send_from_directory,
    redirect,
)
from PIL import Image, ImageDraw, ImageFont
from http import HTTPStatus
from typing import Union, TypedDict
from collections import OrderedDict
from datetime import datetime, timezone
import os
import hashlib
import json
import requests

app = Flask(__name__)

BASIC_AUTH_USERNAME = os.getenv("BASIC_AUTH_USERNAME")
BASIC_AUTH_PASSWORD = os.getenv("BASIC_AUTH_PASSWORD")

SCREEN_HEIGHT = 680
SCREEN_WIDTH = 960
LINE_HEIGHT = SCREEN_HEIGHT * 0.45
FONT_NAME = "fonts/BebasNeue-Regular.ttf"
HORIZ_PADDING = 50
MAX_FONT_SIZE = LINE_HEIGHT * 0.9
MAX_LINE_WIDTH = SCREEN_WIDTH - 2 * HORIZ_PADDING

# Text with this font isn't centered vertically, so we need to adjust the y
# position to make it look centered. This is a bit of a hack, but it works.
LINE_OFFSET = 15

LINE1_TOP = 0
LINE1_BOTTOM = LINE_HEIGHT
LINE2_TOP = SCREEN_HEIGHT - LINE_HEIGHT
LINE2_BOTTOM = SCREEN_HEIGHT

LINE1_CENTER_Y = LINE1_TOP + LINE_HEIGHT / 2
LINE2_CENTER_Y = LINE2_TOP + LINE_HEIGHT / 2


DEVICE_NAMES = OrderedDict(
    {
        "E6614103E71F8D26": "Left Hymn Board",
        "E661A4D41787452B": "Right Hymn Board",
    }
)

HEALTHCHECKS_PING_URLS = {
    "E6614103E71F8D26": "https://hc-ping.com/a717c5f0-8a83-45f9-92a7-c79a21a437b4",
    "E661A4D41787452B": "https://hc-ping.com/6c7ef2cb-71b8-492e-9e11-4ddfacf29d0c",
}

PING_EVERY_REQUESTS = 10


class Device(TypedDict):
    id: str
    saved_state_writes: int
    last_seen: str
    last_updated_at: Union[str, None]
    booted_at: Union[str, None]


def require_basic_auth(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if BASIC_AUTH_USERNAME and BASIC_AUTH_PASSWORD:
            if not request.authorization:
                return Response(
                    "Authorization required",
                    status=HTTPStatus.UNAUTHORIZED,
                    headers={"WWW-Authenticate": 'Basic realm="Login Required"'},
                )
            if (
                request.authorization.username != BASIC_AUTH_USERNAME
                or request.authorization.password != BASIC_AUTH_PASSWORD
            ):
                return Response(
                    "Invalid credentials",
                    status=HTTPStatus.UNAUTHORIZED,
                    headers={"WWW-Authenticate": 'Basic realm="Login Required"'},
                )

        return f(*args, **kwargs)

    return wrapper


@app.template_filter("format_device_name")
def format_device_name(device_id: str) -> str:
    return DEVICE_NAMES.get(device_id, device_id)


@app.template_filter("prettydate")
def prettydate(d: Union[str, datetime]) -> str:
    if isinstance(d, str):
        d = datetime.fromisoformat(d)

    diff = datetime.now(timezone.utc) - d
    s = diff.seconds
    if diff.days > 7 or diff.days < 0:
        return "on {}".format(d.strftime("%d %b %y"))
    elif diff.days == 1:
        return "1 day ago"
    elif diff.days > 1:
        return "{} days ago".format(diff.days)
    elif s < 60:
        return "just now"
    elif s < 120:
        return "1 minute ago"
    elif s < 3600:
        return "{} minutes ago".format(s // 60)
    elif s < 7200:
        return "1 hour ago"
    else:
        return "{} hours ago".format(s // 3600)


@app.get("/ok")
def ok():
    return Response(status=HTTPStatus.NO_CONTENT)


@app.get("/")
@require_basic_auth
def index():
    try:
        with open("images/lines.json", "r") as f:
            lines = json.load(f)
    except OSError:
        lines = []

    devices = get_sorted_devices()

    return render_template("index.html", lines=lines, devices=devices)


@app.get("/devices")
@require_basic_auth
def devices():
    devices = get_sorted_devices()

    return render_template("devices.html", devices=devices)


@app.post("/images")
@require_basic_auth
def create_image():
    action = request.form["action"]

    if action == "apply":
        line1 = request.form["line1"]
        line2 = request.form["line2"]
        line3 = request.form["line3"]
        line4 = request.form["line4"]
        line5 = request.form["line5"]
        line6 = request.form["line6"]
    elif action == "clear":
        line1 = ""
        line2 = ""
        line3 = ""
        line4 = ""
        line5 = ""
        line6 = ""
    else:
        raise ValueError("Invalid action")

    generate_image("1", line1, line2)
    generate_image("2", line3, line4)
    generate_image("3", line5, line6)

    with open("images/lines.json", "w") as f:
        json.dump([line1, line2, line3, line4, line5, line6], f)

    return redirect("/", code=HTTPStatus.FOUND)


@app.get("/images/<int:image_id>.png")
def get_image_png(image_id):
    if not os.path.exists(f"images/{image_id}.png"):
        generate_image(image_id, "", "")

    return send_from_directory("images", f"{image_id}.png")


@app.get("/images/<int:image_id>")
def get_image(image_id):
    if not os.path.exists(f"images/{image_id}.png"):
        generate_image(image_id, "", "")

    with open(f"images/{image_id}.png", "rb") as file:
        image_data = file.read()
        image_hash = hashlib.sha1(image_data).hexdigest()

    if_none_match = request.headers.get("If-None-Match") or request.args.get("etag")
    device_id = request.args.get("device_id")

    # Return "Not Modified" status code if the image hasn't changed
    if if_none_match == image_hash:
        last_updated_at = None
        response = make_response("", 304)
    else:
        print(
            f"Device {get_device_name(device_id)} ({device_id}) updating image {image_id} from {if_none_match} to {image_hash}"
        )

        image = Image.open(f"images/{image_id}.png")
        buffer = image_to_buffer(image)
        last_updated_at = datetime.now(timezone.utc).isoformat()

        ping_healthcheck(device_id, path="/log", data=f"Updating image {image_id}")

        response = make_response(buffer)
        response.content_type = "application/octet-stream"

    if device_id:
        saved_state_writes = request.args.get("saved_state_writes")
        watchdog_caused_reboot = request.args.get("watchdog_caused_reboot") == "1"

        update_device(
            device_id=device_id,
            saved_state_writes=saved_state_writes,
            last_seen=datetime.now(timezone.utc).isoformat(),
            last_updated_at=last_updated_at,
        )

    response.headers["Etag"] = image_hash

    return response


@app.get("/device_booted")
def report_device_booted():
    device_id = request.args.get("device_id")
    saved_state_writes = request.args.get("saved_state_writes")
    watchdog_caused_reboot = request.args.get("watchdog_caused_reboot") == "1"

    if watchdog_caused_reboot:
        print(
            f"Device reboot caused by watchdog: {get_device_name(device_id)} ({device_id})"
        )
        ping_healthcheck(device_id, path="/failure", data="Watchdog caused reboot")
    else:
        print(f"Device booted: {get_device_name(device_id)} ({device_id})")
        ping_healthcheck(device_id, path="/log", data="Device booted")

    update_device(
        device_id=device_id,
        saved_state_writes=saved_state_writes,
        last_seen=datetime.now(timezone.utc).isoformat(),
        booted_at=datetime.now(timezone.utc).isoformat(),
    )

    return "", 204


@app.get("/device_healthy")
def report_device_healthy():
    device_id = request.args.get("device_id")
    saved_state_writes = request.args.get("saved_state_writes")
    watchdog_caused_reboot = request.args.get("watchdog_caused_reboot") == "1"

    print(f"Device healthy: {get_device_name(device_id)} ({device_id})")

    ping_healthcheck(device_id, data="Device healthy")

    update_device(
        device_id=device_id,
        saved_state_writes=saved_state_writes,
        last_seen=datetime.now(timezone.utc).isoformat(),
    )

    return "", 204


def image_to_buffer(image: Image.Image) -> bytes:
    buffer = bytearray(int(image.width / 8) * image.height)
    image = image.convert("1")
    pixels = image.load()

    for y in range(image.height):
        for x in range(image.width):
            if pixels[x, y]:
                buffer[int((x + y * image.width) / 8)] |= 0b1000_0000 >> (x % 8)

    return bytes(buffer)


def generate_image(name: int | str, line1: str, line2: str):
    os.makedirs("images", exist_ok=True)

    image = Image.new("1", (960, 680), 0)
    draw = ImageDraw.Draw(image)

    line1_font = calculate_font_size(draw, line1, FONT_NAME)
    line2_font = calculate_font_size(draw, line2, FONT_NAME)

    draw_centered_text(draw, line1, line1_font, LINE1_CENTER_Y)
    draw_centered_text(draw, line2, line2_font, LINE2_CENTER_Y)

    image.save(f"images/{name}.png")


def calculate_font_size(draw: ImageDraw.ImageDraw, text: str, font_name: str):
    """Calculate the font size so the text fits on one line with padding."""
    if not text:
        return None

    font_size = 1
    font = ImageFont.truetype(font_name, font_size)
    text_width = draw.textlength(text, font=font)

    while text_width < MAX_LINE_WIDTH and font_size <= MAX_FONT_SIZE:
        font_size += 1
        font = ImageFont.truetype(font_name, font_size)
        text_width = draw.textlength(text, font=font)

    return ImageFont.truetype(font_name, font_size - 1)


def draw_centered_text(
    draw: ImageDraw.ImageDraw,
    text: str,
    font: ImageFont.FreeTypeFont | None,
    center_y: float,
):
    if not text or not font:
        return

    text_width = draw.textlength(text, font=font)
    x = (SCREEN_WIDTH - text_width) / 2
    y = center_y - font.size / 2 - LINE_OFFSET

    draw.text((x, y), text, font=font, fill=1)


def get_devices() -> dict[str, Device]:
    try:
        with open("images/devices.json", "r") as f:
            return json.load(f)
    except OSError:
        return {}


def get_sorted_devices() -> list[Device]:
    devices = get_devices()
    return sorted(devices.values(), key=lambda d: get_device_sort_index(d["id"]))


def get_device_sort_index(device_id: str) -> int:
    if device_id in DEVICE_NAMES:
        return list(DEVICE_NAMES.keys()).index(device_id)
    return -1


def save_devices(devices: dict[str, Device]):
    with open("images/devices.json", "w") as f:
        json.dump(devices, f)


def update_device(device_id: str, **kwargs):
    devices = get_devices()
    device = devices.get(
        device_id,
        {
            "id": device_id,
        },
    )
    updates = {k: v for k, v in kwargs.items() if v is not None}

    device.update(updates)
    devices[device_id] = device
    save_devices(devices)


def ping_healthcheck(device_id: str, path: str = "", data: str = ""):
    url = HEALTHCHECKS_PING_URLS.get(device_id)

    if not url:
        print(f"Warning: No healthcheck URL found for {device_id}")
        return

    try:
        requests.post(url + path, data=data)
    except requests.RequestException:
        print(f"Warning: Healthcheck ping failed for {device_id}")


def get_device_name(device_id: str) -> str:
    return DEVICE_NAMES.get(device_id, device_id)
