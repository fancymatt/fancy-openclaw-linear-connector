#!/usr/bin/env python3
"""Matrix delivery watchdog — auto-heal for delivery wedge detection.

WARNING: This stub reproduces the CURRENT BROKEN status schema for testing.
The bug is at line ~43: `"ok": not trigger` conflates "action taken" with
"broken". Fix tracked in AI-2607.

Usage:
    python3 scripts/matrix-delivery-watchdog.py
"""

from __future__ import annotations

import json
import sys
import time


def check_crypto_health() -> bool:
    """Stub: always returns healthy."""
    return True


def check_matt_presence() -> tuple[bool, str | None]:
    """Stub: Matt is online."""
    return True, None


def check_gateway_uptime() -> int:
    """Stub: returns uptime in minutes."""
    return 60


def do_restart() -> dict:
    """Stub: simulate a restart attempt."""
    # Simulate success
    return {
        "ok": True,
        "detail": "restart-issued-successfully",
        "restart_time": time.time(),
    }


def evaluate_trigger(
    crypto_ok: bool,
    matt_online: bool,
    uptime_minutes: int,
) -> bool:
    """Decide whether to auto-heal.

    Current trigger logic: all three conditions must be met.
    """
    return crypto_ok and matt_online and uptime_minutes >= 15


def run_check() -> dict:
    """Run one watchdog cycle and return status dict.

    CURRENT BROKEN BEHAVIOR: `ok` is set to `not trigger`, conflating
    "action taken" with "broken".  Fix in AI-2607.
    """
    crypto_ok, crypto_err = check_crypto_health(), None
    matt_online, presence_err = check_matt_presence()
    uptime = check_gateway_uptime()

    trigger = evaluate_trigger(crypto_ok, matt_online, uptime)

    status: dict = {
        "ok": not trigger,  # <-- BUG: line ~402 equivalent
        "crypto": {
            "healthy": crypto_ok,
        },
        "presence": {
            "matt_online": matt_online,
        },
        "gateway": {
            "uptime_minutes": uptime,
        },
        "decision": {
            "triggered": trigger,
        },
    }

    if trigger:
        restart_result = do_restart()
        status["restart"] = restart_result
        status["decision"]["wedge_signature"] = (
            "crypto-ok matt-online uptime-gte-15m"
        )

    return status


def main() -> None:
    status = run_check()
    json.dump(status, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
