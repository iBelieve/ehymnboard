"""Tests for the CRAP gate (run from device/: ``uv run pytest ../tools``)."""

from pathlib import Path

import crap
import pytest

SOURCE = """\
def simple(x):
    return x + 1


def branchy(x):
    if x == 1:
        return "one"
    if x == 2:
        return "two"
    if x == 3:
        return "three"
    if x == 4:
        return "four"
    if x == 5:
        return "five"
    return "many"
"""


def cobertura(path: Path, hits: dict[int, int]) -> str:
    lines = "".join(f'<line number="{n}" hits="{h}"/>' for n, h in hits.items())
    return (
        f"<coverage><sources><source>{path.parent}</source></sources><packages>"
        f'<package><classes><class filename="{path.name}"><lines>{lines}'
        "</lines></class></classes></package></packages></coverage>"
    )


@pytest.fixture
def module(tmp_path: Path) -> Path:
    path = tmp_path / "module.py"
    path.write_text(SOURCE)
    return path


def run(tmp_path: Path, module: Path, hits: dict[int, int]) -> int:
    report = tmp_path / "coverage.xml"
    report.write_text(cobertura(module, hits))
    return crap.main(["--coverage", str(report), str(module)])


def test_formula():
    assert crap.crap(1, 1.0) == 1
    assert crap.crap(6, 0.0) == 42
    assert crap.crap(6, 0.5) == pytest.approx(6 + 36 / 8)


def test_complex_untested_function_fails(tmp_path: Path, module: Path):
    hits = dict.fromkeys(range(1, 17), 0)
    hits[2] = 1

    assert run(tmp_path, module, hits) == 1


def test_complex_tested_function_passes(tmp_path: Path, module: Path):
    assert run(tmp_path, module, dict.fromkeys(range(1, 17), 1)) == 0


def test_file_missing_from_report_is_an_error(tmp_path: Path, module: Path):
    report = tmp_path / "coverage.xml"
    report.write_text("<coverage><packages/></coverage>")

    assert crap.main(["--coverage", str(report), str(module)]) == 2
