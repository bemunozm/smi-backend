"""Compara dos corridas del benchmark foto por foto.

Uso:
    python compare_runs.py <a> <b>

`a` y `b` son un `per_photo.json` o la carpeta que lo contiene. Cruza por
nombre de archivo e imprime cuantas lecturas CONFIRMED/REVIEW/UNREADABLE hay
en cada corrida y la lista de fotos cuyo `value` o `status` difiere (por
ejemplo, Windows x86 contra Linux ARM64: mismo modelo, distinto runtime).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

STATUSES = ("CONFIRMED", "REVIEW", "UNREADABLE")


def load_rows(source: str) -> dict[str, dict[str, Any]]:
    path = Path(source)
    if path.is_dir():
        path = path / "per_photo.json"
    rows = json.loads(path.read_text(encoding="utf-8"))
    return {row["file"]: row for row in rows}


def count_statuses(rows: dict[str, dict[str, Any]]) -> dict[str, int]:
    counts = {status: 0 for status in STATUSES}
    for row in rows.values():
        status = str(row.get("status"))
        counts[status] = counts.get(status, 0) + 1
    return counts


def find_differences(a: dict[str, dict[str, Any]], b: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    diffs = []
    for name in sorted(a.keys() & b.keys()):
        ra, rb = a[name], b[name]
        if ra.get("value") != rb.get("value") or ra.get("status") != rb.get("status"):
            diffs.append(
                {
                    "file": name,
                    "a": (ra.get("value"), ra.get("status"), ra.get("confidence")),
                    "b": (rb.get("value"), rb.get("status"), rb.get("confidence")),
                }
            )
    return diffs


def render_report(label_a: str, label_b: str, a: dict, b: dict) -> str:
    lines = [f"A = {label_a} ({len(a)} fotos)", f"B = {label_b} ({len(b)} fotos)", ""]
    counts_a, counts_b = count_statuses(a), count_statuses(b)
    lines.append(f"{'status':<12}{'A':>6}{'B':>6}")
    for status in sorted(set(counts_a) | set(counts_b), key=lambda s: (s not in STATUSES, s)):
        lines.append(f"{status:<12}{counts_a.get(status, 0):>6}{counts_b.get(status, 0):>6}")

    only_a, only_b = sorted(a.keys() - b.keys()), sorted(b.keys() - a.keys())
    if only_a or only_b:
        lines += ["", f"Solo en A: {len(only_a)} | Solo en B: {len(only_b)}"]
        lines += [f"  solo A: {name}" for name in only_a] + [f"  solo B: {name}" for name in only_b]

    diffs = find_differences(a, b)
    lines += ["", f"Fotos con value o status distintos: {len(diffs)} de {len(a.keys() & b.keys())} comunes"]
    for diff in diffs:
        va, sa, ca = diff["a"]
        vb, sb, cb = diff["b"]
        lines.append(f"  {diff['file']}\n    A: value={va} status={sa} conf={ca}\n    B: value={vb} status={sb} conf={cb}")
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    a, b = load_rows(argv[1]), load_rows(argv[2])
    print(render_report(argv[1], argv[2], a, b))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
