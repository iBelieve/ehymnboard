from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path

import pytest
from flask.testing import FlaskClient

import app as app_module

SERVER_DIR = Path(__file__).resolve().parent.parent


@dataclass
class Ping:
    url: str
    data: str


@dataclass
class PingRecorder:
    pings: list[Ping] = field(default_factory=list)

    def post(self, url: str, data: str = "", **_kwargs: object) -> None:
        self.pings.append(Ping(url, data))


@pytest.fixture(autouse=True)
def workdir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Run each test in an empty directory, like a fresh deploy.

    The app reads and writes ``images/`` relative to the working directory, so
    this keeps tests from touching each other's (or a developer's) state.
    """
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(app_module, "BASIC_AUTH_USERNAME", None)
    monkeypatch.setattr(app_module, "BASIC_AUTH_PASSWORD", None)
    monkeypatch.setattr(
        app_module, "FONT_NAME", str(SERVER_DIR / "fonts/BebasNeue-Regular.ttf")
    )
    return tmp_path


@pytest.fixture(autouse=True)
def pings(monkeypatch: pytest.MonkeyPatch) -> PingRecorder:
    """Record healthchecks.io pings instead of sending them."""
    recorder = PingRecorder()
    monkeypatch.setattr(app_module.requests, "post", recorder.post)
    return recorder


@pytest.fixture
def client() -> Iterator[FlaskClient]:
    app_module.app.config.update(TESTING=True)
    with app_module.app.test_client() as test_client:
        yield test_client
