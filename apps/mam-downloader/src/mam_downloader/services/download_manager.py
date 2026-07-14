from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from mam_downloader.config import Settings
from mam_downloader.models import (
    BookRequisition,
    DownloadRecord,
    Job,
    JobStatus,
    TorrentMatch,
)
from mam_downloader.services.abs import ABSClient
from mam_downloader.services.mam import MAMClient
from mam_downloader.services.qbittorrent import QBittorrentClient

logger = logging.getLogger(__name__)


class DownloadManagerError(Exception):
    """Base exception for download manager operations."""


class DownloadManager:
    """Orchestrates the full MAM→qBittorrent→ABS pipeline for a book requisition."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.mam = MAMClient(settings)
        self.qb = QBittorrentClient(settings)
        self.abs = ABSClient(settings)
        self._history_path = Path(settings.config_path) / "downloaded.json"

    async def execute(self, job: Job) -> None:
        """Execute the full download pipeline for a job.

        Updates job.status and job.progress as it goes.
        """
        try:
            await self._search_phase(job)
            await self._download_phase(job)
            await self._organize_phase(job)
            await self._scan_phase(job)
        except Exception as exc:
            logger.exception("Job %s failed", job.id)
            job.status = JobStatus.failed
            job.error = str(exc)
        finally:
            await self.close()

    async def search_only(self, book: BookRequisition) -> list[TorrentMatch]:
        """Search MAM and return ranked matches without downloading."""
        try:
            await self.mam.login()
            results = await self.mam.search(
                title=book.title,
                author=book.author,
                isbn=book.isbn,
            )
            ranked = MAMClient.rank_matches(
                results,
                target_title=book.title,
                target_author=book.author,
                target_isbn=book.isbn,
            )
            return ranked
        finally:
            await self.mam.close()

    async def _search_phase(self, job: Job) -> None:
        """Phase 1: Search MAM and select best match."""
        job.status = JobStatus.searching
        job.progress = 0.0

        logger.info("Job %s: Searching MAM for %s", job.id, job.book.title or job.book.isbn)

        await self.mam.login()
        results = await self.mam.search(
            title=job.book.title,
            author=job.book.author,
            isbn=job.book.isbn,
        )
        ranked = MAMClient.rank_matches(
            results,
            target_title=job.book.title,
            target_author=job.book.author,
            target_isbn=job.book.isbn,
        )

        if not ranked:
            raise DownloadManagerError(
                f"No MAM results found for '{job.book.title}'"
            )

        best = ranked[0]
        if best.score < 10.0:
            logger.warning(
                "Job %s: Best match score %.1f is very low for '%s'",
                job.id,
                best.score,
                best.title,
            )

        job.torrent = best
        job.progress = 0.1
        logger.info(
            "Job %s: Best match — '%s' (score=%.1f, seeders=%d)",
            job.id,
            best.title,
            best.score,
            best.seeders,
        )

    async def _download_phase(self, job: Job) -> None:
        """Phase 2: Check duplicates and queue in qBittorrent."""
        if self.settings.dry_run:
            logger.info("Job %s: DRY RUN — skipping qBittorrent queue", job.id)
            job.status = JobStatus.available
            job.progress = 1.0
            return

        torrent = job.torrent
        if not torrent:
            raise DownloadManagerError("No torrent match to download")

        # Check for duplicates
        if await self._is_duplicate(torrent, job.book):
            logger.info("Job %s: Duplicate detected — skipping download", job.id)
            job.status = JobStatus.available
            job.progress = 1.0
            return

        job.status = JobStatus.downloading
        job.progress = 0.2

        logger.info("Job %s: Queuing torrent in qBittorrent", job.id)

        await self.qb.login()
        torrent_hash = await self.qb.add_torrent(torrent.torrent_url)
        if not torrent_hash:
            # Try to get hash from recent torrents
            raise DownloadManagerError("Failed to add torrent to qBittorrent")

        job.progress = 0.3

        # Wait for completion
        logger.info("Job %s: Waiting for download completion (hash=%s)", job.id, torrent_hash)
        completed = await self.qb.wait_for_completion(torrent_hash)

        if not completed:
            raise DownloadManagerError(f"Download timed out for torrent {torrent_hash}")

        job.progress = 0.7
        logger.info("Job %s: Download completed", job.id)

    async def _organize_phase(self, job: Job) -> None:
        """Phase 3: Organize downloaded files into ABS folder structure."""
        job.status = JobStatus.importing
        job.progress = 0.8

        if self.settings.dry_run:
            logger.info("Job %s: DRY RUN — skipping organization", job.id)
            return

        torrent = job.torrent
        if not torrent:
            raise DownloadManagerError("No torrent to organize")

        await self._organize_files(torrent, job.book)
        job.progress = 0.95
        logger.info("Job %s: Files organized", job.id)

    async def _scan_phase(self, job: Job) -> None:
        """Phase 4: Trigger ABS library scan and record download."""
        logger.info("Job %s: Triggering ABS library scan", job.id)

        if not self.settings.dry_run:
            await self.abs.trigger_library_scan()

        # Record in download history
        await self._record_download(job)

        job.status = JobStatus.available
        job.progress = 1.0
        logger.info("Job %s: Complete — available in ABS", job.id)

    async def _organize_files(
        self,
        torrent: TorrentMatch,
        book: BookRequisition,
    ) -> None:
        """Move downloaded files into ABS-compatible folder structure.

        Target: {DOWNLOAD_PATH}/{Author}/{Series?}/{Title}/
        """
        download_base = Path(self.settings.download_path)

        # Determine author directory
        author_dir = book.author.strip() if book.author else (torrent.author.strip() or "Unknown Author")
        safe_author = self._safe_path(author_dir)

        # Determine title directory
        title_dir = book.title.strip() if book.title else torrent.title.strip()
        safe_title = self._safe_path(title_dir)

        # Try to detect series from torrent title
        series_name = self._detect_series(torrent.title)
        if series_name:
            safe_series = self._safe_path(series_name)
            target_dir = download_base / safe_author / safe_series / safe_title
        else:
            target_dir = download_base / safe_author / safe_title

        # Locate completed files in qBittorrent download directory
        # qBittorrent typically downloads to its configured save path
        # We need to find and move the files
        # In v1, we expect torrents to download directly to DOWNLOAD_PATH's parent
        # and we scan for recently added files

        # For v1, we create the directory structure and note that manual
        # organization may be needed for complex cases
        target_dir.mkdir(parents=True, exist_ok=True)

        # Try to find downloaded files in qBittorrent's default save path
        qb_save_path = Path(self.settings.download_path).parent / ".qbittorrent"
        if qb_save_path.exists():
            for item in qb_save_path.iterdir():
                if item.is_file() and self._matches_book(item, book, torrent):
                    dest = target_dir / item.name
                    logger.info("Moving %s → %s", item, dest)
                    shutil.move(str(item), str(dest))
                elif item.is_dir() and self._matches_book(item, book, torrent):
                    shutil.copytree(str(item), str(target_dir / item.name), dirs_exist_ok=True)
                    shutil.rmtree(str(item))

        logger.info("Organized files into %s", target_dir)

    @staticmethod
    def _safe_path(name: str) -> str:
        """Sanitize a string for use as a filesystem path component."""
        safe = re.sub(r'[\\/:*?"<>|]', "_", name)
        safe = re.sub(r"\s+", " ", safe).strip()
        safe = re.sub(r"\.+$", "", safe)
        return safe[:200]

    @staticmethod
    def _detect_series(title: str) -> str | None:
        """Try to detect a series name from the torrent title.

        Common patterns: "Series Name, Book X: Title" or "Series Name: Title"
        """
        # Match patterns like "Series Name, Book X:" or "Series Name:"
        series_match = re.search(
            r"^(.+?),\s*(?:Book|Vol(?:ume)?)\s+\d+[:\-\u2013]",
            title,
            re.IGNORECASE,
        )
        if series_match:
            return series_match.group(1).strip()

        # "Series Name #X:" pattern
        series_match = re.search(
            r"^(.+?)\s*#\d+[:\-\u2013]",
            title,
        )
        if series_match:
            return series_match.group(1).strip()

        return None

    @staticmethod
    def _matches_book(path: Path, book: BookRequisition, torrent: TorrentMatch) -> bool:
        """Heuristic check if a file path matches the target book."""
        name_lower = path.name.lower()
        title_words = (book.title or torrent.title).lower().split()
        if not title_words:
            return True
        # Check if at least half the title words appear in the filename
        matches = sum(1 for w in title_words if w in name_lower)
        return matches >= len(title_words) / 2

    async def _is_duplicate(
        self,
        torrent: TorrentMatch,
        book: BookRequisition,
    ) -> bool:
        """Check download history for duplicate torrents or ISBNs."""
        history = await self._load_history()
        torrent_id = self._extract_torrent_id(torrent.torrent_url)

        for record in history:
            if record.torrent_id == torrent_id:
                logger.info("Duplicate torrent_id: %s", torrent_id)
                return True
            if book.isbn and record.isbn == book.isbn:
                logger.info("Duplicate ISBN: %s", book.isbn)
                return True
        return False

    async def _record_download(self, job: Job) -> None:
        """Record a completed download in history."""
        if self.settings.dry_run:
            return

        torrent = job.torrent
        if not torrent:
            return

        history = await self._load_history()

        record = DownloadRecord(
            torrent_id=self._extract_torrent_id(torrent.torrent_url),
            title=torrent.title,
            author=torrent.author or job.book.author,
            isbn=job.book.isbn,
            path=str(Path(self.settings.download_path)),
            timestamp=datetime.now(timezone.utc).isoformat(),
        )
        history.append(record)
        await self._save_history(history)

    async def _load_history(self) -> list[DownloadRecord]:
        """Load download history from JSON file."""
        if not self._history_path.exists():
            return []

        try:
            data = json.loads(self._history_path.read_text())
            return [DownloadRecord(**item) for item in data]
        except (json.JSONDecodeError, KeyError):
            logger.warning("Corrupt download history file, starting fresh")
            return []

    async def _save_history(self, records: list[DownloadRecord]) -> None:
        """Save download history to JSON file."""
        self._history_path.parent.mkdir(parents=True, exist_ok=True)
        data = [r.model_dump() for r in records]
        self._history_path.write_text(json.dumps(data, indent=2))

    @staticmethod
    def _extract_torrent_id(torrent_url: str) -> str:
        """Extract torrent ID from a MAM download URL."""
        match = re.search(r"id=(\d+)", torrent_url)
        return match.group(1) if match else ""

    async def close(self) -> None:
        """Close all service clients."""
        await self.mam.close()
        await self.qb.close()
        await self.abs.close()
