#!/usr/bin/env python3
"""Redact credential-shaped tokens from .trajectory.jsonl files in-place.

Reuses lib/secret_patterns.SECRET_RX (the shared compiled regex) so the
shape definitions are exactly what every other scanner in the fleet agrees
on — not a second regex that drifts.

Usage:
    python3 redact-trajectory.py --secret-patterns-path /path/to/secret_patterns.py file1.jsonl [file2 ...]

Output (JSON to stdout): summary of what was redacted.

Exit code: 0 on success (files may or may not have been modified).
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys


def load_secret_patterns(script_path: str | None) -> tuple:
    """Load SECRET_RX, label_for, NONCE_LABELS from the shared scanner.

    Resolution order:
      1. --secret-patterns-path CLI flag
      2. SECRET_PATTERNS_PATH env var
      3. Fallback: scripts/lib/secret_patterns.py relative to this script
    """
    path = script_path or os.environ.get("SECRET_PATTERNS_PATH")
    if not path:
        here = os.path.dirname(os.path.abspath(__file__))
        candidate = os.path.join(here, "lib", "secret_patterns.py")
        if os.path.exists(candidate):
            path = candidate

    if not path or not os.path.exists(path):
        # Last resort: try the system-wide ai-repo
        for guess in (
            "/home/node/ai-repo/scripts/lib/secret_patterns.py",
            "/home/fancymatt/ai-repo/scripts/lib/secret_patterns.py",
            os.path.expanduser("~/ai-repo/scripts/lib/secret_patterns.py"),
        ):
            if os.path.exists(guess):
                path = guess
                break

    if not path or not os.path.exists(path):
        sys.stderr.write(f"redact-trajectory: cannot locate secret_patterns.py (resolved: {path})\n")
        sys.exit(1)

    spec = importlib.util.spec_from_file_location("secret_patterns", path)
    if spec is None or spec.loader is None:
        sys.stderr.write(f"redact-trajectory: cannot load secret_patterns from {path}\n")
        sys.exit(1)

    sp = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(sp)
    return sp.SECRET_RX, sp.label_for, sp.NONCE_LABELS


REDACTION_MARKER = b"[REDACTED:"


def redact_line(line: bytes, secret_rx, label_fn, nonce_set: frozenset[str]) -> tuple[bytes, list[str]]:
    """Redact every credential-shaped match in a single line of bytes.

    Returns (redacted_line, [matched_labels]).
    """
    labels: list[str] = []
    result = bytearray()
    pos = 0
    for m in secret_rx.finditer(line):
        start, end = m.start(), m.end()
        tok = m.group()
        lab = label_fn(tok)
        if lab is None:
            continue  # benign (git's own userinfo, internal host)
        labels.append(lab)
        # Copy everything before the match
        result.extend(line[pos:start])
        # Replace with redaction marker
        result.extend(REDACTION_MARKER)
        result.extend(lab.encode("utf-8"))
        result.extend(b"]")
        pos = end
    result.extend(line[pos:])
    return bytes(result), labels


def redact_file(path: str, secret_rx, label_fn, nonce_set) -> dict:
    """Read a .trajectory.jsonl file, redact in-place, return stats."""
    result: dict = {
        "path": path,
        "modified": False,
        "lines_scanned": 0,
        "total_redactions": 0,
        "labels_found": [],
        "error": None,
    }
    try:
        with open(path, "rb") as fh:
            original = fh.read()
    except OSError as e:
        result["error"] = str(e)
        return result

    lines = original.split(b"\n")
    redacted_lines: list[bytes] = []
    seen_labels: set[str] = set()
    total_redactions = 0
    modified = False

    for line in lines:
        result["lines_scanned"] += 1
        redacted, labels = redact_line(line, secret_rx, label_fn, nonce_set)
        if labels:
            modified = True
            total_redactions += len(labels)
            seen_labels.update(labels)
        redacted_lines.append(redacted)

    if modified:
        try:
            with open(path, "wb") as fh:
                fh.write(b"\n".join(redacted_lines))
        except OSError as e:
            result["error"] = f"write failed: {e}"
            return result

    result["modified"] = modified
    result["total_redactions"] = total_redactions
    result["labels_found"] = sorted(seen_labels)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Redact credential-shaped tokens from .trajectory.jsonl files"
    )
    parser.add_argument(
        "--secret-patterns-path",
        help="Path to lib/secret_patterns.py (default: auto-resolve)",
    )
    parser.add_argument(
        "files", nargs="+", help=".trajectory.jsonl files to redact"
    )
    args = parser.parse_args()

    secret_rx, label_fn, nonce_set = load_secret_patterns(args.secret_patterns_path)

    results: list[dict] = []
    for path in args.files:
        results.append(redact_file(path, secret_rx, label_fn, nonce_set))

    summary = {
        "files": results,
        "total_files": len(results),
        "modified_files": sum(1 for r in results if r["modified"]),
        "errors": [r["error"] for r in results if r["error"]],
        "total_redactions": sum(r["total_redactions"] for r in results),
    }
    print(json.dumps(summary, indent=2))
    # Exit with error count so the TypeScript caller can detect partial failures.
    if summary["errors"]:
        sys.exit(1)


if __name__ == "__main__":
    main()
