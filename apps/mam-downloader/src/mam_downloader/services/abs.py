from __future__ import annotations

import logging

import httpx

from mam_downloader.config import Settings

logger = logging.getLogger(__name__)


class ABSError(Exception):
    """Base exception for Audiobookshelf operations."""


class ABSClient:
    """Client for Audiobookshelf API."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._client: httpx.AsyncClient | None = None

    async def _ensure_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                base_url=self.settings.abs_url,
                headers={
                    "Authorization": f"Bearer {self.settings.abs_api_key}",
                },
                timeout=30.0,
            )
        return self._client

    async def trigger_library_scan(self) -> bool:
        """Trigger an Audiobookshelf library scan.

        Returns True if the scan was triggered successfully.
        """
        client = await self._ensure_client()

        # ABS API: POST /api/libraries/{id}/scan
        # First, get library list
        try:
            libs_resp = await client.get("/api/libraries")
            if libs_resp.status_code != 200:
                logger.error(
                    "Failed to get ABS libraries: %s %s",
                    libs_resp.status_code,
                    libs_resp.text[:200],
                )
                return False

            libraries = libs_resp.json().get("libraries", [])
            if not libraries:
                logger.warning("No ABS libraries found to scan")
                return False

            # Scan all libraries (usually just one for audiobooks)
            for lib in libraries:
                lib_id = lib.get("id")
                if lib_id:
                    scan_resp = await client.post(f"/api/libraries/{lib_id}/scan")
                    if scan_resp.status_code in (200, 204):
                        logger.info("Triggered ABS scan for library %s", lib.get("name", lib_id))
                    else:
                        logger.warning(
                            "ABS scan trigger returned %s for library %s",
                            scan_resp.status_code,
                            lib_id,
                        )

            return True

        except httpx.RequestError as exc:
            logger.error("ABS request failed: %s", exc)
            return False

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None
