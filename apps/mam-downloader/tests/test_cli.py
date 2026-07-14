from __future__ import annotations

import os
import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from mam_downloader.app import create_app
from mam_downloader.config import Settings


class TestCLIDryRun:
    """Tests for --dry-run CLI flag."""

    def test_dry_run_flag_prevents_download(self) -> None:
        """--dry-run should set settings.dry_run to True."""
        from mam_downloader.cli import main as cli_main

        with patch.object(sys, "argv", ["mam-downloader", "--dry-run", "--title", "Test Book"]), \
             patch("mam_downloader.cli.run_dry_run") as mock_dry_run:

            cli_main()

            mock_dry_run.assert_called_once()

    def test_dry_run_with_author(self) -> None:
        """--dry-run with --author passes author to search."""
        from mam_downloader.cli import main as cli_main

        with patch.object(sys, "argv", [
            "mam-downloader", "--dry-run", "--title", "Test Book", "--author", "Test Author",
        ]), \
             patch("mam_downloader.cli.run_dry_run") as mock_dry_run:

            cli_main()

            # Verify the call args
            call_args = mock_dry_run.call_args[0]
            assert call_args[1] == "Test Book"
            assert call_args[2] == "Test Author"

    def test_dry_run_with_isbn(self) -> None:
        """--dry-run with --isbn passes isbn to search."""
        from mam_downloader.cli import main as cli_main

        with patch.object(sys, "argv", [
            "mam-downloader", "--dry-run", "--isbn", "9780756404741",
        ]), \
             patch("mam_downloader.cli.run_dry_run") as mock_dry_run:

            cli_main()

            call_args = mock_dry_run.call_args[0]
            assert call_args[3] == "9780756404741"


class TestCLIServe:
    """Tests for --serve CLI flag."""

    def test_serve_flag_starts_uvicorn(self) -> None:
        """--serve flag starts the uvicorn server."""
        from mam_downloader.cli import main as cli_main, run_server

        with patch.object(sys, "argv", ["mam-downloader", "--serve"]), \
             patch("mam_downloader.cli.run_server") as mock_run:

            cli_main()

            mock_run.assert_called_once()


class TestCLIHelp:
    """Tests for CLI without flags."""

    def test_no_args_shows_help(self) -> None:
        """Running without args prints help and exits."""
        from mam_downloader.cli import main as cli_main

        with patch.object(sys, "argv", ["mam-downloader"]), \
             pytest.raises(SystemExit) as exc_info:

            cli_main()

        assert exc_info.value.code == 1


class TestDockerfile:
    """Validates the Dockerfile contents."""

    def test_dockerfile_exists(self) -> None:
        """Dockerfile exists in the project root."""
        dockerfile_path = Path(__file__).parent.parent / "Dockerfile"
        assert dockerfile_path.exists(), "Dockerfile not found"

    def test_dockerfile_python_slim(self) -> None:
        """Dockerfile uses python:3.12-slim."""
        dockerfile_path = Path(__file__).parent.parent / "Dockerfile"
        content = dockerfile_path.read_text()
        assert "python:3.12-slim" in content

    def test_dockerfile_exposes_8687(self) -> None:
        """Dockerfile exposes port 8687."""
        dockerfile_path = Path(__file__).parent.parent / "Dockerfile"
        content = dockerfile_path.read_text()
        assert "8687" in content


class TestDockerCompose:
    """Validates the docker-compose.yml contents."""

    def test_docker_compose_exists(self) -> None:
        """docker-compose.yml exists."""
        compose_path = Path(__file__).parent.parent / "docker-compose.yml"
        assert compose_path.exists()

    def test_docker_compose_port_8687(self) -> None:
        """docker-compose.yml maps port 8687."""
        compose_path = Path(__file__).parent.parent / "docker-compose.yml"
        content = compose_path.read_text()
        assert "8687" in content

    def test_docker_compose_python_image(self) -> None:
        """docker-compose.yml references python:3.12-slim or mam-downloader image."""
        compose_path = Path(__file__).parent.parent / "docker-compose.yml"
        content = compose_path.read_text()
        assert "mam-downloader" in content


class TestKnownLimitations:
    """Validates KNOWN_LIMITATIONS.md exists and covers required topics."""

    def test_known_limitations_exists(self) -> None:
        """KNOWN_LIMITATIONS.md exists."""
        limitations_path = Path(__file__).parent.parent / "KNOWN_LIMITATIONS.md"
        assert limitations_path.exists()

    def test_covers_mam_session_expiry(self) -> None:
        """Covers MAM session expiry limitation."""
        limitations_path = Path(__file__).parent.parent / "KNOWN_LIMITATIONS.md"
        content = limitations_path.read_text()
        assert "session" in content.lower()

    def test_covers_no_ongoing_monitoring(self) -> None:
        """Covers no ongoing monitoring limitation."""
        limitations_path = Path(__file__).parent.parent / "KNOWN_LIMITATIONS.md"
        content = limitations_path.read_text()
        assert "monitoring" in content.lower()
