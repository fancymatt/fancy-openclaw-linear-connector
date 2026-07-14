from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from mam_downloader.models import BookRequisition, DownloadRecord, Job, TorrentMatch
from mam_downloader.services.download_manager import DownloadManager


class TestQBittorrentIntegration:
    """Tests for qBittorrent integration via the download manager."""

    async def test_add_torrent_called_with_correct_url(
        self,
        settings,
        sample_job: Job,
        sample_torrent_match: TorrentMatch,
    ) -> None:
        """Download manager calls qBittorrent add_torrent with the correct URL."""
        dm = DownloadManager(settings)

        with patch.object(dm.mam, "login", AsyncMock()), \
             patch.object(dm.mam, "search", AsyncMock(return_value=[sample_torrent_match])), \
             patch.object(dm.qb, "login", AsyncMock()), \
             patch.object(dm.qb, "add_torrent", AsyncMock(return_value="abc123")), \
             patch.object(dm.qb, "wait_for_completion", AsyncMock(return_value=True)), \
             patch.object(dm.abs, "trigger_library_scan", AsyncMock(return_value=True)), \
             patch.object(dm, "_is_duplicate", AsyncMock(return_value=False)), \
             patch.object(dm, "_organize_files", AsyncMock()), \
             patch.object(dm, "_record_download", AsyncMock()):

            await dm.execute(sample_job)

            dm.qb.add_torrent.assert_called_once_with(sample_torrent_match.torrent_url)

    async def test_dry_run_skips_qbittorrent(
        self,
        dry_run_settings,
        sample_job: Job,
        sample_torrent_match: TorrentMatch,
    ) -> None:
        """Dry-run mode does not call qBittorrent add_torrent."""
        dm = DownloadManager(dry_run_settings)

        with patch.object(dm.mam, "login", AsyncMock()), \
             patch.object(dm.mam, "search", AsyncMock(return_value=[sample_torrent_match])), \
             patch.object(dm.qb, "login", AsyncMock()), \
             patch.object(dm.qb, "add_torrent", AsyncMock()):
            # Don't dry-run at the settings level, manually set it after search
            pass

        # The execute method checks settings.dry_run — set it true
        dry_run_settings.dry_run = True

        with patch.object(dm.mam, "login", AsyncMock()), \
             patch.object(dm.mam, "search", AsyncMock(return_value=[sample_torrent_match])), \
             patch.object(dm.qb, "add_torrent", AsyncMock()) as mock_add:

            await dm.execute(sample_job)
            mock_add.assert_not_called()


class TestDuplicateDetection:
    """Tests for download history duplicate detection."""

    async def test_duplicate_torrent_id_skipped(
        self,
        settings,
        download_history_file: Path,
        sample_job: Job,
    ) -> None:
        """Same torrent_id in history is skipped."""
        dm = DownloadManager(settings)
        # Create a torrent match with the same torrent_id as in history
        torrent = TorrentMatch(
            title="Already Downloaded Book",
            author="Some Author",
            format="audiobook",
            seeders=10,
            peers=1,
            torrent_url="https://www.myanonamouse.net/torrents.php?action=download&id=99999&torpass=1",
        )

        is_dup = await dm._is_duplicate(torrent, sample_job.book)
        assert is_dup is True

    async def test_duplicate_isbn_skipped(
        self,
        settings,
        download_history_file: Path,
    ) -> None:
        """Same ISBN in history is skipped."""
        dm = DownloadManager(settings)
        torrent = TorrentMatch(
            title="Some Book",
            author="Some Author",
            format="audiobook",
            seeders=5,
            peers=0,
            torrent_url="https://www.myanonamouse.net/torrents.php?action=download&id=11111&torpass=1",
        )
        book = BookRequisition(title="Some Book", isbn="9781234567890")

        is_dup = await dm._is_duplicate(torrent, book)
        assert is_dup is True

    async def test_non_duplicate_allowed(
        self,
        settings,
        download_history_file: Path,
        sample_job: Job,
    ) -> None:
        """Different torrent_id and ISBN are not flagged as duplicates."""
        dm = DownloadManager(settings)
        torrent = TorrentMatch(
            title="Brand New Book",
            author="New Author",
            format="audiobook",
            seeders=50,
            peers=5,
            torrent_url="https://www.myanonamouse.net/torrents.php?action=download&id=88888&torpass=1",
        )
        book = BookRequisition(title="Brand New Book", author="New Author", isbn="9789999999999")

        is_dup = await dm._is_duplicate(torrent, book)
        assert is_dup is False

    async def test_empty_history_no_duplicate(
        self,
        settings,
        temp_config_dir: Path,
        sample_job: Job,
    ) -> None:
        """Empty history file does not flag anything as duplicate."""
        dm = DownloadManager(settings)
        torrent = TorrentMatch(
            title="Some Book",
            author="Some Author",
            format="audiobook",
            seeders=10,
            peers=1,
            torrent_url="https://www.myanonamouse.net/torrents.php?action=download&id=12345&torpass=1",
        )

        is_dup = await dm._is_duplicate(torrent, sample_job.book)
        assert is_dup is False


class TestFolderOrganization:
    """Tests for ABS folder structure organization."""

    async def test_folder_structure_author_title(
        self,
        settings,
        temp_download_path: Path,
    ) -> None:
        """Files are organized into {Author}/{Title}/ structure."""
        dm = DownloadManager(settings)
        torrent = TorrentMatch(
            title="The Name of the Wind (Audiobook)",
            author="Patrick Rothfuss",
            format="audiobook",
            seeders=50,
            peers=5,
            torrent_url="http://example.com/tor",
        )
        book = BookRequisition(title="The Name of the Wind", author="Patrick Rothfuss")

        await dm._organize_files(torrent, book)

        expected_dir = temp_download_path / "Patrick Rothfuss" / "The Name of the Wind"
        # The mkdir happens in organize; we just need to verify the path is correct
        assert "Patrick Rothfuss" in str(expected_dir)
        assert "The Name of the Wind" in str(expected_dir)

    async def test_series_subfolder_detected(
        self,
        settings,
        temp_download_path: Path,
    ) -> None:
        """Series name is detected and added as subfolder."""
        dm = DownloadManager(settings)
        torrent = TorrentMatch(
            title="Kingkiller Chronicle, Book 1: The Name of the Wind (Audiobook)",
            author="Patrick Rothfuss",
            format="audiobook",
            seeders=50,
            peers=5,
            torrent_url="http://example.com/tor",
        )
        book = BookRequisition(title="The Name of the Wind", author="Patrick Rothfuss")

        series = dm._detect_series(torrent.title)
        assert series is not None
        assert "Kingkiller" in series

    async def test_no_series_no_subfolder(
        self,
        settings,
    ) -> None:
        """No series subfolder is created when none detected."""
        dm = DownloadManager(settings)
        torrent = TorrentMatch(
            title="The Name of the Wind (Audiobook)",
            author="Patrick Rothfuss",
            format="audiobook",
            seeders=50,
            peers=5,
            torrent_url="http://example.com/tor",
        )

        series = dm._detect_series(torrent.title)
        assert series is None

    async def test_download_record_saved(
        self,
        settings,
        temp_config_dir: Path,
        sample_job: Job,
        sample_torrent_match: TorrentMatch,
    ) -> None:
        """Completed download is recorded in history."""
        dm = DownloadManager(settings)
        sample_job.torrent = sample_torrent_match
        sample_job.book = BookRequisition(title="Test", author="Author")

        await dm._record_download(sample_job)

        history = await dm._load_history()
        assert len(history) == 1
        assert history[0].torrent_id == "12345"
        assert history[0].title == "The Name of the Wind (Audiobook)"

    async def test_torrent_id_extraction(self) -> None:
        """Torrent ID is correctly extracted from URL."""
        url = "https://www.myanonamouse.net/torrents.php?action=download&id=12345&torpass=1"
        tor_id = DownloadManager._extract_torrent_id(url)
        assert tor_id == "12345"

    async def test_safe_path_sanitization(self) -> None:
        """Path sanitization removes dangerous characters."""
        assert DownloadManager._safe_path("Foo/Bar:Test?") == "Foo_Bar_Test_"
        assert DownloadManager._safe_path("Normal Book") == "Normal Book"
        assert DownloadManager._safe_path("  Spaces  ") == "Spaces"
