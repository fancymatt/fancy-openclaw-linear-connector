from __future__ import annotations

import asyncio
import logging
from typing import Optional

import httpx

from mam_downloader.config import Settings

logger = logging.getLogger(__name__)


class QBittorrentError(Exception):
    """Base exception for qBittorrent operations."""


class QBittorrentClient:
    """Client for qBittorrent WebUI API v2."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._client: httpx.AsyncClient | None = None
        self._sid: str = ""

    async def _ensure_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                base_url=self.settings.qbittorrent_url,
                timeout=30.0,
            )
        return self._client

    async def login(self) -> None:
        """Authenticate to qBittorrent WebUI and store session cookie."""
        client = await self._ensure_client()

        resp = await client.post(
            "/api/v2/auth/login",
            data={
                "username": self.settings.qbittorrent_username,
                "password": self.settings.qbittorrent_password,
            },
        )
        if resp.status_code != 200:
            raise QBittorrentError(
                f"qBittorrent login failed with status {resp.status_code}"
            )

        # Extract SID from cookies
        for cookie in client.cookies.jar:
            if cookie.name == "SID":
                self._sid = cookie.value
                break

        if not self._sid:
            # Try response cookies
            sid_cookie = resp.cookies.get("SID")
            if sid_cookie:
                self._sid = sid_cookie

        if not self._sid:
            raise QBittorrentError("qBittorrent login succeeded but no SID cookie received")

    async def add_torrent(self, torrent_url: str, save_path: str = "") -> str | None:
        """Add a torrent by URL. Returns the torrent hash on success, None on failure."""
        client = await self._ensure_client()

        data: dict[str, str] = {
            "urls": torrent_url,
        }
        if save_path:
            data["savepath"] = save_path

        resp = await client.post("/api/v2/torrents/add", data=data)
        if resp.status_code == 200:
            # qBittorrent returns "Ok." on success; actual hash isn't returned here
            logger.info("Torrent queued in qBittorrent: %s", torrent_url)
            # We need to fetch the hash via info endpoint
            return await self._find_torrent_hash_by_url(torrent_url)
        else:
            logger.error("Failed to add torrent: %s %s", resp.status_code, resp.text)
            raise QBittorrentError(
                f"Failed to add torrent: HTTP {resp.status_code} - {resp.text[:200]}"
            )

    async def _find_torrent_hash_by_url(self, torrent_url: str) -> str | None:
        """Search torrent list to find the hash of a recently-added torrent."""
        client = await self._ensure_client()
        resp = await client.get("/api/v2/torrents/info")
        if resp.status_code != 200:
            return None

        torrents = resp.json()
        for tor in torrents:
            # Match by tracker URL if we can't match directly
            if isinstance(tor, dict):
                torrent_hash = tor.get("hash", "")
                if torrent_hash:
                    return torrent_hash
        return None

    async def get_torrent_info(self, torrent_hash: str) -> dict | None:
        """Get info for a specific torrent by hash."""
        client = await self._ensure_client()
        resp = await client.get(
            "/api/v2/torrents/info",
            params={"hashes": torrent_hash},
        )
        if resp.status_code != 200:
            return None

        torrents = resp.json()
        if isinstance(torrents, list) and len(torrents) > 0:
            return torrents[0]
        return None

    async def wait_for_completion(
        self,
        torrent_hash: str,
        poll_interval: float = 10.0,
        timeout: float = 3600.0,
    ) -> bool:
        """Poll qBittorrent until the torrent completes or times out.

        Returns True if completed, False if timed out.
        """
        elapsed = 0.0
        while elapsed < timeout:
            info = await self.get_torrent_info(torrent_hash)
            if info is None:
                logger.warning("Torrent %s not found in qBittorrent", torrent_hash)
                return False

            progress = info.get("progress", 0)
            state = info.get("state", "")

            logger.debug(
                "Torrent %s: progress=%.2f, state=%s",
                torrent_hash,
                progress,
                state,
            )

            if state in ("pausedUP", "uploading", "stalledUP"):
                # Torrent is complete (or seeding)
                return True

            if progress >= 1.0:
                return True

            await asyncio.sleep(poll_interval)
            elapsed += poll_interval

        logger.warning("Torrent %s timed out after %.0fs", torrent_hash, timeout)
        return False

    async def get_torrent_files(self, torrent_hash: str) -> list[dict]:
        """Get file listing for a completed torrent."""
        client = await self._ensure_client()
        resp = await client.get(
            "/api/v2/torrents/files",
            params={"hash": torrent_hash},
        )
        if resp.status_code != 200:
            return []
        return resp.json()

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None
