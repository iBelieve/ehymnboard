#!/usr/bin/env python3
"""Fail CI when a function is both complex and poorly tested.

CRAP (Change Risk Anti-Patterns) combines cyclomatic complexity with test
coverage, so a complex function is fine as long as tests exercise it:

    CRAP(f) = complexity(f)^2 * (1 - coverage(f))^3 + complexity(f)

A score above 30 is the usual "this is risky to change" line. Complexity comes
from lizard (Python and C++), coverage from a Cobertura XML report, which both
coverage.py (``coverage xml``) and gcovr (``--cobertura``) write. Coverage is
per line, measured over the lines of each function.

Usage: crap.py --coverage coverage.xml [--threshold 30] FILE...
"""

import argparse
import sys
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path

import lizard

DEFAULT_THRESHOLD = 30.0


@dataclass(frozen=True)
class Score:
    file: str
    function: str
    line: int
    complexity: int
    coverage: float

    @property
    def crap(self) -> float:
        return crap(self.complexity, self.coverage)


def crap(complexity: int, coverage: float) -> float:
    return complexity**2 * (1 - coverage) ** 3 + complexity


def load_cobertura(report: Path) -> dict[Path, dict[int, int]]:
    """Map each file in the report (resolved) to {line number: hit count}."""
    root = ET.parse(report).getroot()  # noqa: S314 - our own coverage report
    sources = [Path(s.text) for s in root.iter("source") if s.text]
    sources.append(report.resolve().parent)

    lines_by_file: dict[Path, dict[int, int]] = {}
    for cls in root.iter("class"):
        filename = cls.get("filename")
        if not filename:
            continue
        candidates = [Path(filename)] + [base / filename for base in sources]
        path = next((c for c in candidates if c.exists()), candidates[0])
        hits = lines_by_file.setdefault(path.resolve(), {})
        for line in cls.iter("line"):
            number = int(line.get("number", "0"))
            hits[number] = hits.get(number, 0) + int(line.get("hits", "0"))
    return lines_by_file


def function_coverage(hits: dict[int, int], start: int, end: int) -> float:
    lines = [n for n in hits if start <= n <= end]
    if not lines:
        # Nothing instrumented (e.g. compiled out): assume untested.
        return 0.0
    return sum(1 for n in lines if hits[n] > 0) / len(lines)


def score_file(path: Path, hits: dict[int, int]) -> list[Score]:
    analysis = lizard.analyze_file(str(path))
    return [
        Score(
            file=str(path),
            function=fn.name,
            line=fn.start_line,
            complexity=fn.cyclomatic_complexity,
            coverage=function_coverage(hits, fn.start_line, fn.end_line),
        )
        for fn in analysis.function_list
    ]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Fail on high-CRAP functions.")
    parser.add_argument("--coverage", type=Path, required=True)
    parser.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD)
    parser.add_argument("--top", type=int, default=10, help="rows to print")
    parser.add_argument("files", type=Path, nargs="+")
    args = parser.parse_args(argv)

    report = load_cobertura(args.coverage)
    scores: list[Score] = []
    for path in args.files:
        hits = report.get(path.resolve())
        if hits is None:
            print(f"error: {path} is not in {args.coverage}", file=sys.stderr)
            return 2
        scores.extend(score_file(path, hits))

    scores.sort(key=lambda s: s.crap, reverse=True)
    print(f"{'CRAP':>7} {'CCN':>4} {'cover':>6}  function")
    for s in scores[: args.top]:
        print(
            f"{s.crap:7.1f} {s.complexity:4d} {s.coverage:6.0%}  "
            f"{s.function} ({s.file}:{s.line})"
        )

    failing = [s for s in scores if s.crap > args.threshold]
    if failing:
        print(
            f"\n{len(failing)} function(s) over the CRAP threshold of "
            f"{args.threshold:g}. Add tests or simplify them.",
            file=sys.stderr,
        )
        return 1
    print(f"\nAll {len(scores)} functions are within CRAP {args.threshold:g}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
