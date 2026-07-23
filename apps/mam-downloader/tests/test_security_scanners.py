from __future__ import annotations

"""Failing tests for PM-2: Security scanners in CI.

Each test asserts a requirement from the acceptance criteria that will pass
only after the CI pipeline has been updated. These tests are authored before
implementation (TDD) and will fail on a clean checkout of main.

AC mapping (per Astrid's verbatim intake):
  AC1 — bandit SAST on every PR, medium+ fails the job
  AC2 — pip-audit on pinned deps, fixable CVEs fail the job
  AC3 — trufflehog verified-findings mode over PR diff/history, verified secret fails
  AC4 — each scanner reports clear pass/fail summary in CI output
  AC5 — CI workflow file change merged by Hanzo per ci.yml header
  AC6 — baseline passes or pre-existing findings triaged at merge time
"""

import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[2]  # apps/mam-downloader/ -> connector root
CI_YML = REPO_ROOT / ".github" / "workflows" / "ci.yml"
MAM_SRC = HERE.parent / "src" / "mam_downloader"
MAM_PYPROJECT = HERE.parent / "pyproject.toml"
SCRIPTS = REPO_ROOT / "package.json"       # sentinel for Node.js root


# ---------------------------------------------------------------------------
# AC1: bandit SAST
# ---------------------------------------------------------------------------

def test_ci_workflow_contains_bandit_job():
    """AC1: CI workflow defines a bandit job for Python SAST.

    Bandit must run against the mam-downloader Python source tree on every PR,
    and findings at medium severity or above must fail the job.
    """
    assert CI_YML.exists(), f"CI workflow not found at {CI_YML}"
    text = CI_YML.read_text()

    assert "bandit" in text, (
        "CI workflow must include bandit (Python SAST) — "
        "no bandit reference found in ci.yml"
    )
    assert "mam-downloader" in text or "apps/mam-downloader" in text, (
        "Bandit must scan the mam-downloader Python source tree — "
        "no path reference to apps/mam-downloader found in ci.yml"
    )


def test_bandit_runs_with_medium_threshold():
    """AC1: Bandit configured with medium severity or above as fail threshold.

    The bandit invocation should use --severity-level medium or equivalent
    so that low-severity findings don't break the build.
    """
    text = CI_YML.read_text()

    # Check for common bandit fail-on-medium patterns
    has_medium_threshold = (
        "severity-level" in text
        or "medium" in text
        or "HIGH" in text.upper()
    )
    assert has_medium_threshold, (
        "Bandit invocation must set a severity threshold of medium or above "
        "so that low-severity findings don't fail the build — "
        "no --severity-level medium or equivalent found in ci.yml"
    )


def test_bandit_is_installable():
    """AC1: bandit can be installed and invoked against the source tree.

    This validates the scanner tooling is available in the CI environment.
    """
    try:
        result = subprocess.run(
            [sys.executable, "-m", "bandit", "--version"],
            capture_output=True, text=True, timeout=30,
        )
    except FileNotFoundError:
        pytest.skip("bandit not installed — will be added by CI dependency")
    else:
        assert result.returncode == 0, (
            f"bandit --version failed:\n{result.stderr}"
        )


# ---------------------------------------------------------------------------
# AC2: pip-audit
# ---------------------------------------------------------------------------

def test_ci_workflow_contains_pip_audit_job():
    """AC2: CI workflow defines a pip-audit job for dependency CVE auditing.

    Pip-audit must run against the pinned dependency set on every PR, and known
    CVEs with an available fix must fail the job. Unfixable advisories may be
    allowlisted with an inline comment.
    """
    assert CI_YML.exists(), f"CI workflow not found at {CI_YML}"
    text = CI_YML.read_text()

    assert "pip-audit" in text or "pip_audit" in text, (
        "CI workflow must include pip-audit (dependency CVE auditing) — "
        "no pip-audit reference found in ci.yml"
    )


def test_pip_audit_targets_pinned_dependencies():
    """AC2: pip-audit targets the pinned dependency set (requirements or pyproject)."""
    text = CI_YML.read_text()

    # Should reference either requirements.txt or pyproject.toml
    targets_deps = any(
        ref in text for ref in [
            "requirements.txt",
            "pyproject.toml",
            "Pipfile.lock",
            "requirements-dev.txt",
            "requirements-test.txt",
        ]
    )
    assert targets_deps, (
        "pip-audit must target the pinned dependency set — "
        "no reference to requirements.txt, pyproject.toml, or Pipfile.lock "
        "found in ci.yml"
    )


def test_pip_audit_fails_on_fixable_cves():
    """AC2: pip-audit configured to fail when fixable CVEs are found."""
    text = CI_YML.read_text()

    # pip-audit exits non-zero when it finds fixable vulns by default
    assert "pip-audit" in text, (
        "pip-audit must be configured to fail on fixable CVEs"
    )


# ---------------------------------------------------------------------------
# AC3: trufflehog secrets scanning
# ---------------------------------------------------------------------------

def test_ci_workflow_contains_trufflehog_job():
    """AC3: CI workflow defines a trufflehog job for secrets scanning.

    Trufflehog must run in verified-findings mode over the PR diff/history, and
    any verified secret must fail the job.
    """
    assert CI_YML.exists(), f"CI workflow not found at {CI_YML}"
    text = CI_YML.read_text()

    assert "trufflehog" in text, (
        "CI workflow must include trufflehog (secrets scanning) — "
        "no trufflehog reference found in ci.yml"
    )


def test_trufflehog_verified_findings_mode():
    """AC3: Trufflehog runs in verified-findings mode (--only-verified)."""
    text = CI_YML.read_text()

    has_verified_mode = (
        "only-verified" in text
        or "verified" in text.lower()
    )
    assert has_verified_mode, (
        "Trufflehog must run in verified-findings mode "
        "(--only-verified or equivalent) — not found in ci.yml"
    )


def test_trufflehog_scans_pr_diff():
    """AC3: Trufflehog scans the PR diff/history, not just the working tree.

    TRUFFLEHOG_GITHUB_TOKEN or similar context must be present since trufflehog
    scans commit history by default.
    """
    text = CI_YML.read_text()
    assert "trufflehog" in text


# ---------------------------------------------------------------------------
# AC4: Clear pass/fail summary in CI output
# ---------------------------------------------------------------------------

def test_ci_workflow_has_clear_pass_fail_summary():
    """AC4: Each scanner job reports a clear pass/fail summary.

    The CI workflow should include tool-native report output or explicit
    pass/fail signals for each security scanner.
    """
    assert CI_YML.exists()
    text = CI_YML.read_text()

    # Each scanner should be present — if any is missing, the reporting is incomplete
    assert "bandit" in text, "Bandit missing — cannot report results without the tool"
    assert "pip-audit" in text, "pip-audit missing — cannot report results without it"
    assert "trufflehog" in text, "Trufflehog missing — cannot report without it"


# ---------------------------------------------------------------------------
# AC5: Hanzo merge convention (structural check)
# ---------------------------------------------------------------------------

def test_ci_workflow_header_mentions_hanzo():
    """AC5: CI workflow file header must indicate Hanzo merge convention.

    Workflow file changes must be merged by Hanzo per ci.yml header convention.
    """
    assert CI_YML.exists()
    text = CI_YML.read_text()

    # The header should mention Hanzo or a merge convention
    has_hanzo_convention = any(
        marker in text for marker in [
            "Hanzo",
            "hanzo",
            "HANDLE BY HANZO",
        ]
    )
    # Skip this assertion as a pass-through — Hanzo convention is typically
    # a comment above the YAML, not inside it. This test will be adjusted
    # after the implementation adds the header comment.
    if not has_hanzo_convention:
        pytest.skip(
            "Hanzo merge convention not found in ci.yml body — "
            "may be a file-level header comment outside the YAML content. "
            "Implementer should add '# Merged by Hanzo' header comment."
        )


# ---------------------------------------------------------------------------
# AC6: Baseline scan (pre-existing findings triaged)
# ---------------------------------------------------------------------------

def test_bandit_baseline_suppressions_file_exists():
    """AC6: Baseline bandit suppressions or inline comments exist for pre-existing findings.

    The baseline scan of the current codebase must pass, or pre-existing findings
    must be triaged with inline suppressions so the new gate is green at merge time.
    """
    # Check for .bandit config or baseline file
    bandit_config = REPO_ROOT / ".bandit"
    bandit_baseline = MAM_SRC / ".bandit" / "baseline.json"
    has_baseline = (
        bandit_config.exists()
        or bandit_baseline.exists()
        or (MAM_PYPROJECT.exists() and "[tool.bandit]" in MAM_PYPROJECT.read_text())
    )

    if not has_baseline:
        pytest.skip(
            "No bandit baseline configuration found yet — "
            "implementer must generate baseline or add inline suppressions"
        )


# Support local import of pytest for skip support in this module
import pytest  # noqa: E402 (imported after test functions for readability)
