#!/usr/bin/env python3
"""FAILING tests for AI-2607: matrix-delivery-watchdog status schema fix.

Current broken behavior: line ~402 sets `"ok": not trigger`, making `ok`
FALSE whenever the watchdog *decides to act* — even on a successful auto-heal.

Correct behavior (AC):
  1. `ok` reflects whether the run completed without internal error.
  2. "Action taken" is tracked in `decision.triggered` (already exists).
  3. `ok: false` ONLY when the watchdog itself malfunctioned:
     - crypto check errored
     - presence check errored
     - restart was attempted but `restart.ok: false`
  4. `decision.triggered` is independent of `ok`.

These tests define the correct contract and MUST FAIL against the current
broken implementation at line ~43 (`"ok": not trigger`).
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

WATCHDOG_PATH = (
    Path(__file__).resolve().parent.parent / "matrix-delivery-watchdog.py"
)


def run_watchdog() -> dict[str, Any]:
    """Run the watchdog script and parse its JSON output."""
    result = subprocess.run(
        [sys.executable, str(WATCHDOG_PATH)],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, f"watchdog stderr: {result.stderr}"
    return json.loads(result.stdout)


def _load_watchdog_module():
    """Load the watchdog module by file path (hyphens in filename)."""
    spec = importlib.util.spec_from_file_location(
        "matrix_delivery_watchdog", WATCHDOG_PATH
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ---------------------------------------------------------------------------
# AC1: ok reflects internal error, not action-taken
# ---------------------------------------------------------------------------


@pytest.mark.ac("AC1")
def test_ok_true_when_run_clean_no_trigger() -> None:
    """`ok` is true when the watchdog runs cleanly and does NOT trigger."""
    status = run_watchdog()
    # Current broken: trigger=false → ok=true (this one passes accidentally)
    # But we assert the logic, not the coincidence
    assert status["ok"] is True, (
        "ok should be True when run completes without internal error, "
        f"got {status['ok']}"
    )
    assert status["decision"]["triggered"] is False, status["decision"]


@pytest.mark.ac("AC1")
def test_ok_true_when_trigger_and_restart_succeeds() -> None:
    """`ok` is true when watchdog triggers AND restart succeeds.

    This is the PRIMARY failing test against the current broken schema:
    current code sets `ok = not trigger`, making this `ok: false` even
    though everything worked correctly.
    """
    status = run_watchdog()
    # With crypto ok + matt online + uptime >= 15, trigger is TRUE
    assert status["decision"]["triggered"] is True, (
        "Precondition: trigger should be active under stub conditions"
    )
    assert status["ok"] is True, (
        "AC1: ok should be True when a triggered restart succeeds — "
        "the watchdog did its job correctly. "
        "Current broken code sets ok=False because trigger=True."
    )


# ---------------------------------------------------------------------------
# AC2: ok is false on genuine internal errors
# ---------------------------------------------------------------------------


@pytest.mark.ac("AC2")
def test_ok_false_when_crypto_check_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    """`ok` is false when crypto health check fails."""
    wd = _load_watchdog_module()

    monkeypatch.setattr(wd, "check_crypto_health", lambda: False)
    status = wd.run_check()
    assert status["ok"] is False, (
        "ok should be False when crypto check indicates unhealthy"
    )
    assert status["decision"]["triggered"] is False


@pytest.mark.ac("AC2")
def test_ok_false_when_presence_check_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    """`ok` is false when Matt presence check errors out."""
    wd = _load_watchdog_module()

    def broken_presence() -> tuple[bool, str]:
        return False, "presence-api-timeout"

    monkeypatch.setattr(wd, "check_matt_presence", broken_presence)
    status = wd.run_check()
    assert status["ok"] is False, (
        "ok should be False when presence check errors out"
    )


@pytest.mark.ac("AC2")
def test_ok_false_when_restart_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    """`ok` is false when restart is attempted but fails.

    CRITICAL: This test distinguishes correct behavior from the current
    broken `ok = not trigger` logic.  In the broken code, `ok` is False
    ONLY because trigger=True, and the restart-failed case is invisible.
    When we also monkeypatch crypto to fail (trigger=False), the broken
    code would return ok=True (not trigger = True), while the correct
    code should still return ok=False because restart attempted and
    failed — but since restart isn't called when trigger=False, this
    scenario actually proves that restart failure → ok=False when
    restart IS called is the correct path.

    The sharper distinction: with the fix, ok=True when restart succeeds
    AND trigger is True (test_ok_true_when_trigger_and_restart_succeeds).
    That test MUST fail now (broken code returns ok=False because
    trigger=True), proving this test's pass is coincidental.
    """
    wd = _load_watchdog_module()

    def failed_restart() -> dict:
        return {"ok": False, "detail": "restart-timed-out"}

    monkeypatch.setattr(wd, "do_restart", failed_restart)
    status = wd.run_check()
    # Trigger is true (crypto ok, matt online, uptime >= 15)
    assert status["decision"]["triggered"] is True
    assert status["restart"]["ok"] is False, status["restart"]
    assert status["ok"] is False, (
        "ok should be False when restart is attempted but fails"
    )


@pytest.mark.ac("AC2")
def test_ok_false_crypto_error_even_if_would_trigger(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`ok` is false when crypto fails, even though trigger would fire.

    In the correct schema, internal errors always result in ok=False
    regardless of trigger state.  The current broken code sets
    ok = not trigger, so when crypto is unhealthy → trigger=False →
    ok=True — exactly backwards.  This test is RED against the bug.
    """
    wd = _load_watchdog_module()

    monkeypatch.setattr(wd, "check_crypto_health", lambda: False)
    status = wd.run_check()
    assert status["decision"]["triggered"] is False, (
        "crypto failure should prevent triggering"
    )
    # Broken: ok = not trigger = True (WRONG — crypto failed!)
    # Correct: ok = False (crypto check errored)
    assert status["ok"] is False, (
        "ok should be False when crypto check fails — "
        "internal error beats trigger state. "
        "Broken code returns ok=True because trigger=False."
    )


# ---------------------------------------------------------------------------
# AC3: decision.triggered is independent of ok
# ---------------------------------------------------------------------------


@pytest.mark.ac("AC3")
def test_decision_triggered_separate_from_ok(monkeypatch: pytest.MonkeyPatch) -> None:
    """`decision.triggered` is an independent field, not a proxy for ok."""
    wd = _load_watchdog_module()

    # Case 1: triggered=True, restart succeeds → ok=True, triggered=True
    status = wd.run_check()
    assert status["ok"] is True
    assert status["decision"]["triggered"] is True
    assert status.get("restart", {}).get("ok") is True

    # Case 2: crypto unhealthy → ok=False (error), triggered=False
    monkeypatch.setattr(wd, "check_crypto_health", lambda: False)
    status2 = wd.run_check()
    assert status2["ok"] is False  # crypto error
    assert status2["decision"]["triggered"] is False


# ---------------------------------------------------------------------------
# AC4: ok true when no trigger and all checks pass (exists schema output)
# ---------------------------------------------------------------------------


@pytest.mark.ac("AC4")
def test_status_schema_contains_ok_and_decision_fields() -> None:
    """The status dict includes both `ok` and `decision.triggered` fields."""
    status = run_watchdog()
    assert "ok" in status, "status must include top-level ok field"
    assert "decision" in status, "status must include decision block"
    assert "triggered" in status["decision"], (
        "decision block must include triggered field"
    )
