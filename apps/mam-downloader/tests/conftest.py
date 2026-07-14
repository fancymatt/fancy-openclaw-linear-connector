from __future__ import annotations

import json
import tempfile
from pathlib import Path
from typing import AsyncGenerator, Generator

import pytest
from fastapi.testclient import TestClient

from mam_downloader.app import create_app
from mam_downloader.config import Settings
from mam_downloader.models import BookRequisition, Job, TorrentMatch
from mam_downloader.services.abs import ABSClient
from mam_downloader.services.download_manager import DownloadManager
from mam_downloader.services.mam import (
    MAMClient,
    TorrentMatch as MAMTorrentMatch,
)
from mam_downloader.services.qbittorrent import QBittorrentClient


@pytest.fixture
def temp_config_dir() -> Generator[Path, None, None]:
    """Create a temporary config directory for test isolation."""
    with tempfile.TemporaryDirectory() as tmpdir:
        yield Path(tmpdir)


@pytest.fixture
def temp_download_path() -> Generator[Path, None, None]:
    """Create a temporary download directory."""
    with tempfile.TemporaryDirectory() as tmpdir:
        yield Path(tmpdir)


@pytest.fixture
def settings(temp_config_dir: Path, temp_download_path: Path) -> Settings:
    """Create test settings pointing to temporary directories."""
    return Settings(
        mam_base_url="https://www.myanonamouse.net",
        mam_username="test_user",
        mam_password="test_pass",
        qbittorrent_url="http://localhost:8080",
        qbittorrent_username="admin",
        qbittorrent_password="admin",
        abs_url="http://localhost:13378",
        abs_api_key="test_api_key",
        download_path=str(temp_download_path),
        config_path=str(temp_config_dir),
        dry_run=False,
    )


@pytest.fixture
def dry_run_settings(settings: Settings) -> Settings:
    """Settings with dry_run enabled."""
    settings.dry_run = True
    return settings


@pytest.fixture
def sample_torrent_match() -> TorrentMatch:
    """Create a sample torrent match for testing."""
    return TorrentMatch(
        title="The Name of the Wind (Audiobook)",
        author="Patrick Rothfuss",
        year=2007,
        format="audiobook",
        seeders=120,
        peers=15,
        size_bytes=500_000_000,
        torrent_url="https://www.myanonamouse.net/torrents.php?action=download&id=12345&torpass=1",
        score=95.0,
    )


@pytest.fixture
def sample_book_requisition() -> BookRequisition:
    """Create a sample book requisition."""
    return BookRequisition(
        title="The Name of the Wind",
        author="Patrick Rothfuss",
    )


@pytest.fixture
def sample_job(sample_book_requisition: BookRequisition) -> Job:
    """Create a sample job."""
    return Job.create(sample_book_requisition)


@pytest.fixture
def download_history_file(temp_config_dir: Path) -> Path:
    """Create a pre-populated download history file."""
    history = [
        {
            "torrent_id": "99999",
            "title": "Already Downloaded Book",
            "author": "Some Author",
            "isbn": "9781234567890",
            "path": "/data/media/audiobooks",
            "timestamp": "2026-07-01T12:00:00+00:00",
        }
    ]
    path = temp_config_dir / "downloaded.json"
    path.write_text(json.dumps(history, indent=2))
    return path


@pytest.fixture
def app(settings: Settings) -> TestClient:
    """Create a FastAPI test client."""
    application = create_app(settings)
    return TestClient(application)


@pytest.fixture
def mock_mam_client(mocker) -> MAMClient:
    """Create a mocked MAMClient."""
    mock = mocker.AsyncMock(spec=MAMClient)
    return mock


@pytest.fixture
def mock_qb_client(mocker) -> QBittorrentClient:
    """Create a mocked QBittorrentClient."""
    mock = mocker.AsyncMock(spec=QBittorrentClient)
    return mock


@pytest.fixture
def mock_abs_client(mocker) -> ABSClient:
    """Create a mocked ABSClient."""
    mock = mocker.AsyncMock(spec=ABSClient)
    return mock


@pytest.fixture
def mock_download_manager(mocker) -> DownloadManager:
    """Create a mocked DownloadManager."""
    mock = mocker.AsyncMock(spec=DownloadManager)
    return mock
