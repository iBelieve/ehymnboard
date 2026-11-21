"""Tests for the "last seen" relative timestamps on the admin page."""

from datetime import UTC, datetime, timedelta

import pytest
from hypothesis import given
from hypothesis import strategies as st

from app import format_device_name, prettydate


def ago(**kwargs: float) -> datetime:
    return datetime.now(UTC) - timedelta(**kwargs)


@pytest.mark.parametrize(
    ("delta", "expected"),
    [
        (timedelta(seconds=5), "just now"),
        (timedelta(seconds=90), "1 minute ago"),
        (timedelta(minutes=42, seconds=10), "42 minutes ago"),
        (timedelta(minutes=90), "1 hour ago"),
        (timedelta(hours=5, minutes=10), "5 hours ago"),
        (timedelta(days=1, hours=2), "1 day ago"),
        (timedelta(days=3, hours=2), "3 days ago"),
    ],
)
def test_relative_times(delta: timedelta, expected: str):
    assert prettydate(datetime.now(UTC) - delta) == expected


def test_old_dates_are_absolute():
    d = datetime(2024, 12, 25, 10, 0, tzinfo=UTC)
    assert prettydate(d) == "on 25 Dec 24"


def test_future_dates_are_absolute():
    d = datetime.now(UTC) + timedelta(days=2)
    assert prettydate(d).startswith("on ")


def test_accepts_iso_strings_as_stored_in_devices_json():
    assert prettydate(ago(seconds=3).isoformat()) == "just now"


@given(seconds=st.integers(min_value=0, max_value=7 * 24 * 3600))
def test_recent_past_is_always_relative(seconds: int):
    text = prettydate(ago(seconds=seconds))
    assert text == "just now" or text.endswith(" ago")


@given(
    d=st.datetimes(
        min_value=datetime(2000, 1, 1),
        max_value=datetime(2100, 1, 1),
        timezones=st.just(UTC),
    )
)
def test_any_aware_datetime_formats(d: datetime):
    assert prettydate(d)


def test_format_device_name():
    assert format_device_name("E661A4D41787452B") == "Right Hymn Board"
    assert format_device_name("ABCDEF") == "ABCDEF"
