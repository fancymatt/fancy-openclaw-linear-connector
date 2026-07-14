from __future__ import annotations

import re
from typing import Optional

import httpx
from bs4 import BeautifulSoup

from mam_downloader.config import Settings
from mam_downloader.models import TorrentMatch


class MAMError(Exception):
    """Base exception for MAM operations."""


class MAMAuthError(MAMError):
    """Raised when MAM login or session is invalid."""


class MAMClient:
    """Client for MyAnonamouse (MAM) torrent site."""

    BASE_PATH = "/"

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._client: httpx.AsyncClient | None = None
        self._logged_in = False

    async def _ensure_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                base_url=self.settings.mam_base_url,
                headers={
                    "User-Agent": "MAM-Downloader/0.1.0",
                },
                follow_redirects=True,
                timeout=30.0,
            )
        return self._client

    async def login(self) -> None:
        """Authenticate with MAM and store session cookies."""
        client = await self._ensure_client()

        resp = await client.post(
            "/ajax.php",
            data={
                "username": self.settings.mam_username,
                "password": self.settings.mam_password,
            },
        )
        if resp.status_code != 200:
            raise MAMAuthError(f"MAM login failed with status {resp.status_code}")

        data = resp.json()
        if not data.get("Success"):
            raise MAMAuthError(f"MAM login rejected: {data.get('Error', 'unknown error')}")

        self._logged_in = True

    async def _check_logged_in(self, html: str) -> bool:
        """Check if the response contains a login page (session expired)."""
        return "login" not in html.lower()[:500]

    async def search(
        self,
        title: str = "",
        author: str = "",
        isbn: str = "",
    ) -> list[TorrentMatch]:
        """Search MAM browse.php and return parsed torrent results.

        Searches by ISBN if provided, otherwise by title+author.
        """
        if not self._logged_in:
            await self.login()

        client = await self._ensure_client()

        params: dict[str, str] = {
            "tor": "1",  # Torrent search
            "browse": "1",  # Browse mode
            "perpage": "50",
        }
        if isbn:
            params["srch"] = isbn
            params["srchh"] = "All Fields"
        else:
            terms = title
            if author:
                terms = f"{title} {author}"
            params["srch"] = terms
            params["srchh"] = "Title"

        resp = await client.post("/browse.php", data=params)

        if resp.status_code != 200:
            raise MAMError(f"MAM search failed with status {resp.status_code}")

        html = resp.text

        if not await self._check_logged_in(html):
            # Session expired — re-login and retry once
            self._logged_in = False
            await self.login()
            resp = await client.post("/browse.php", data=params)
            if resp.status_code != 200:
                raise MAMError(f"MAM search failed on retry with status {resp.status_code}")
            html = resp.text

        return self._parse_search_results(html)

    def _parse_search_results(self, html: str) -> list[TorrentMatch]:
        """Parse the MAM browse.php HTML into TorrentMatch objects."""
        soup = BeautifulSoup(html, "lxml")
        results: list[TorrentMatch] = []

        # MAM browse.php uses a table with class 'torrent_table' or similar.
        # Each row (<tr>) contains TD cells with title, author, format, etc.
        rows = soup.select("table.torrent_table tr.torrent_row")
        if not rows:
            # Fallback: look for any rows with torrent data
            rows = soup.select("tr.torrent_row")

        for row in rows:
            match = self._parse_torrent_row(row)
            if match is not None:
                results.append(match)

        return results

    def _parse_torrent_row(self, row: BeautifulSoup) -> TorrentMatch | None:
        """Parse a single torrent table row into a TorrentMatch."""
        cells = row.find_all("td")
        if len(cells) < 4:
            return None

        title_cell = cells[0]
        link = title_cell.find("a", href=True)
        if not link:
            return None

        title_text = link.get_text(strip=True)
        href = link["href"]

        # Extract text from all remaining relevant cells
        author_cell = cells[1] if len(cells) > 1 else None
        author_text = author_cell.get_text(strip=True) if author_cell else ""

        size_cell = cells[2] if len(cells) > 2 else None
        size_text = size_cell.get_text(strip=True) if size_cell else "0 B"

        se_cell = cells[3] if len(cells) > 3 else None
        se_text = se_cell.get_text(strip=True) if se_cell else "0"

        le_cell = cells[4] if len(cells) > 4 else None
        le_text = le_cell.get_text(strip=True) if le_cell else "0"

        # Parse format from title or category
        fmt = self._detect_format(title_text)

        # Parse year from title
        year = self._parse_year(title_text)

        # Extract torrent ID from href
        torrent_id = ""
        tid_match = re.search(r"id=(\d+)", href)
        if tid_match:
            torrent_id = tid_match.group(1)

        torrent_url = f"{self.settings.mam_base_url}/torrents.php?action=download&id={torrent_id}&torpass=1"

        return TorrentMatch(
            title=title_text,
            author=author_text,
            year=year,
            format=fmt,
            seeders=int(re.sub(r"\D", "", se_text) or "0"),
            peers=int(re.sub(r"\D", "", le_text) or "0"),
            size_bytes=self._parse_size(size_text),
            torrent_url=torrent_url,
        )

    @staticmethod
    def _detect_format(title: str) -> str:
        """Detect torrent format from title text."""
        lower = title.lower()
        if any(kw in lower for kw in ("audiobook", "audio book", "unabridged")):
            return "audiobook"
        if any(kw in lower for kw in ("ebook", "epub", "mobi", "pdf")):
            return "ebook"
        if "study guide" in lower:
            return "study_guide"
        return "unknown"

    @staticmethod
    def _parse_year(title: str) -> int:
        """Extract a 4-digit year from the title string."""
        years = re.findall(r"\b(19\d{2}|20\d{2})\b", title)
        return int(years[0]) if years else 0

    @staticmethod
    def _parse_size(size_str: str) -> int:
        """Parse a human-readable size string to bytes."""
        size_str = size_str.strip()
        units = {
            "B": 1,
            "KB": 1024,
            "MB": 1024**2,
            "GB": 1024**3,
            "TB": 1024**4,
        }
        match = re.match(r"([\d.]+)\s*(B|KB|MB|GB|TB)", size_str, re.IGNORECASE)
        if match:
            value = float(match.group(1))
            unit = match.group(2).upper()
            return int(value * units.get(unit, 1))
        return 0

    @staticmethod
    def rank_matches(
        results: list[TorrentMatch],
        target_title: str = "",
        target_author: str = "",
        target_isbn: str = "",
    ) -> list[TorrentMatch]:
        """Score and rank torrent matches by relevance.

        Scoring factors:
        - Exact title match (case-insensitive): +50
        - Partial title match (words overlap): +20
        - Exact author match (case-insensitive): +30
        - Partial author match: +10
        - Format preference: audiobook +20, ebook +5, study_guide -10
        - Seeders: capped log bonus (max +10 for 1000+ seeders)
        """
        target_title_lower = target_title.lower().strip()
        target_author_lower = target_author.lower().strip()
        target_title_words = set(target_title_lower.split())

        for match in results:
            score = 0.0

            # Title matching
            match_title_lower = match.title.lower()
            if target_title_lower and match_title_lower == target_title_lower:
                score += 50.0
            elif target_title_lower:
                # Partial: count word overlap ratio
                match_words = set(match_title_lower.split())
                if target_title_words and match_words:
                    overlap = len(target_title_words & match_words)
                    ratio = overlap / max(len(target_title_words), len(match_words))
                    score += 20.0 * ratio

            # Author matching
            match_author_lower = match.author.lower()
            if target_author_lower and match_author_lower == target_author_lower:
                score += 30.0
            elif target_author_lower and (
                target_author_lower in match_author_lower
                or match_author_lower in target_author_lower
            ):
                score += 10.0

            # Format preference
            fmt = match.format.lower()
            if fmt == "audiobook":
                score += 20.0
            elif fmt == "ebook":
                score += 5.0
            elif fmt == "study_guide":
                score -= 10.0

            # Seeder bonus (diminishing returns)
            if match.seeders > 0:
                seeder_bonus = min(10.0, 2.0 * (match.seeders**0.5))
                score += seeder_bonus

            match.score = round(score, 1)

        # Sort descending by score
        results.sort(key=lambda m: m.score, reverse=True)
        return results

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None
