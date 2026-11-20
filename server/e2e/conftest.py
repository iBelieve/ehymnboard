"""Browser end-to-end tests against a running server (see README).

Run with ``uv run pytest e2e --base-url http://localhost:8000``. Set
``E2E_USERNAME``/``E2E_PASSWORD`` if the server has basic auth enabled.
"""

import os
from typing import Any
from urllib.parse import urlsplit

import pytest
from playwright.sync_api import Page, Route


@pytest.fixture(scope="session")
def browser_type_launch_args(
    browser_type_launch_args: dict[str, Any],
) -> dict[str, Any]:
    # Lets a machine with a preinstalled Chromium skip `playwright install`.
    executable = os.getenv("E2E_CHROMIUM_EXECUTABLE")
    if executable:
        return {**browser_type_launch_args, "executable_path": executable}
    return browser_type_launch_args


@pytest.fixture(scope="session")
def credentials() -> tuple[str, str] | None:
    username = os.getenv("E2E_USERNAME")
    password = os.getenv("E2E_PASSWORD")
    return (username, password) if username and password else None


@pytest.fixture(scope="session")
def browser_context_args(
    browser_context_args: dict[str, Any], credentials: tuple[str, str] | None
) -> dict[str, Any]:
    if credentials:
        username, password = credentials
        return {
            **browser_context_args,
            "http_credentials": {"username": username, "password": password},
        }
    return browser_context_args


@pytest.fixture(autouse=True)
def offline(page: Page, base_url: str) -> None:
    """Keep tests hermetic: block the CDN and web fonts the page pulls in."""
    host = urlsplit(base_url).netloc

    def handle(route: Route) -> None:
        if urlsplit(route.request.url).netloc == host:
            route.continue_()
        else:
            route.abort()

    page.route("**/*", handle)
