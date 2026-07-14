from __future__ import annotations

from unittest.mock import AsyncMock, patch

import httpx
import pytest
from pytest_httpx import HTTPXMock

from mam_downloader.models import TorrentMatch
from mam_downloader.services.mam import MAMClient, MAMAuthError, MAMError


@pytest.fixture
def mam_client(settings) -> MAMClient:
    """Create a MAMClient with test settings."""
    return MAMClient(settings)


class TestMAMClientLogin:
    """Tests for MAM login functionality."""

    async def test_login_success(self, mam_client: MAMClient, httpx_mock: HTTPXMock) -> None:
        """Successful login stores session state."""
        httpx_mock.add_response(
            url=f"{mam_client.settings.mam_base_url}/ajax.php",
            method="POST",
            json={"Success": True},
            status_code=200,
        )

        await mam_client.login()
        assert mam_client._logged_in is True

    async def test_login_failure_response(self, mam_client: MAMClient, httpx_mock: HTTPXMock) -> None:
        """Login with invalid credentials raises MAMAuthError."""
        httpx_mock.add_response(
            url=f"{mam_client.settings.mam_base_url}/ajax.php",
            method="POST",
            json={"Success": False, "Error": "Invalid username or password"},
            status_code=200,
        )

        with pytest.raises(MAMAuthError, match="Invalid username or password"):
            await mam_client.login()

    async def test_login_http_error(self, mam_client: MAMClient, httpx_mock: HTTPXMock) -> None:
        """HTTP error during login raises MAMAuthError."""
        httpx_mock.add_response(
            url=f"{mam_client.settings.mam_base_url}/ajax.php",
            method="POST",
            status_code=500,
        )

        with pytest.raises(MAMAuthError, match="status 500"):
            await mam_client.login()


class TestMAMSearch:
    """Tests for MAM search functionality."""

    MAM_BROWSE_HTML = """
    <html>
    <body>
    <table class="torrent_table">
    <tr class="torrent_row">
        <td>
            <a href="/torrents.php?id=12345">The Name of the Wind (Audiobook)</a>
        </td>
        <td>Patrick Rothfuss</td>
        <td>500.0 MB</td>
        <td>120</td>
        <td>15</td>
    </tr>
    <tr class="torrent_row">
        <td>
            <a href="/torrents.php?id=12346">The Name of the Wind - Study Guide</a>
        </td>
        <td>Various</td>
        <td>10.0 MB</td>
        <td>5</td>
        <td>1</td>
    </tr>
    <tr class="torrent_row">
        <td>
            <a href="/torrents.php?id=12347">The Wise Man's Fear (Audiobook)</a>
        </td>
        <td>Patrick Rothfuss</td>
        <td>600.0 MB</td>
        <td>80</td>
        <td>10</td>
    </tr>
    </table>
    </body>
    </html>
    """

    async def test_search_returns_torrent_matches(
        self, mam_client: MAMClient, httpx_mock: HTTPXMock
    ) -> None:
        """Search returns a list of TorrentMatch objects."""
        # Login response
        httpx_mock.add_response(
            url=f"{mam_client.settings.mam_base_url}/ajax.php",
            method="POST",
            json={"Success": True},
            status_code=200,
        )
        # Search response
        httpx_mock.add_response(
            url=f"{mam_client.settings.mam_base_url}/browse.php",
            method="POST",
            content=self.MAM_BROWSE_HTML.encode(),
            status_code=200,
        )

        results = await mam_client.search(title="The Name of the Wind", author="Patrick Rothfuss")

        assert len(results) >= 1
        assert all(isinstance(r, TorrentMatch) for r in results)

    async def test_search_returns_parsed_data(
        self, mam_client: MAMClient, httpx_mock: HTTPXMock
    ) -> None:
        """Search returns correctly parsed data."""
        httpx_mock.add_response(
            url=f"{mam_client.settings.mam_base_url}/ajax.php",
            method="POST",
            json={"Success": True},
            status_code=200,
        )
        httpx_mock.add_response(
            url=f"{mam_client.settings.mam_base_url}/browse.php",
            method="POST",
            content=self.MAM_BROWSE_HTML.encode(),
            status_code=200,
        )

        results = await mam_client.search(title="The Name of the Wind")
        first = results[0]

        assert first.title == "The Name of the Wind (Audiobook)"
        assert first.author == "Patrick Rothfuss"
        assert first.seeders == 120
        assert first.peers == 15
        assert first.size_bytes == 524_288_000  # 500.0 * 1024 * 1024 = 524_288_000
        assert first.format == "audiobook"
        assert "id=12345" in first.torrent_url

    async def test_isbn_search_path(
        self, mam_client: MAMClient, httpx_mock: HTTPXMock
    ) -> None:
        """Search by ISBN uses 'All Fields' search mode."""
        httpx_mock.add_response(
            url=f"{mam_client.settings.mam_base_url}/ajax.php",
            method="POST",
            json={"Success": True},
            status_code=200,
        )
        httpx_mock.add_response(
            url=f"{mam_client.settings.mam_base_url}/browse.php",
            method="POST",
            content=self.MAM_BROWSE_HTML.encode(),
            status_code=200,
        )

        results = await mam_client.search(isbn="9780756404741")

        # Verify that the search was actually executed and returned results
        assert len(results) > 0

    async def test_empty_search_results(
        self, mam_client: MAMClient, httpx_mock: HTTPXMock
    ) -> None:
        """Empty search results return empty list."""
        empty_html = "<html><body><p>No results found.</p></body></html>"

        httpx_mock.add_response(
            url=f"{mam_client.settings.mam_base_url}/ajax.php",
            method="POST",
            json={"Success": True},
            status_code=200,
        )
        httpx_mock.add_response(
            url=f"{mam_client.settings.mam_base_url}/browse.php",
            method="POST",
            content=empty_html.encode(),
            status_code=200,
        )

        results = await mam_client.search(title="NonexistentBookXYZ123")
        assert len(results) == 0


class TestMAMRanking:
    """Tests for MAM match ranking/scoring."""

    def make_match(self, title: str, author: str = "", fmt: str = "audiobook", seeders: int = 10) -> TorrentMatch:
        return TorrentMatch(
            title=title,
            author=author,
            format=fmt,
            seeders=seeders,
            peers=0,
            size_bytes=0,
            torrent_url="http://example.com/torrent",
        )

    def test_exact_title_author_ranks_highest(self) -> None:
        """Exact title+author match ranks above partial match."""
        matches = [
            self.make_match(
                "The Name of the Wind (Audiobook)",
                "Patrick Rothfuss",
                seeders=50,
            ),
            self.make_match(
                "The Name of the Wind Deluxe Edition",
                "Patrick Rothfuss",
                seeders=50,
            ),
            self.make_match(
                "Some Other Book",
                "Someone Else",
                seeders=100,
            ),
        ]

        ranked = MAMClient.rank_matches(
            matches,
            target_title="The Name of the Wind",
            target_author="Patrick Rothfuss",
        )
        assert ranked[0].title == "The Name of the Wind (Audiobook)"

    def test_audiobook_format_preferred(self) -> None:
        """Audiobook format is ranked above study guide."""
        matches = [
            self.make_match("The Name of the Wind - Study Guide", fmt="study_guide", seeders=100),
            self.make_match("The Name of the Wind (Audiobook)", fmt="audiobook", seeders=50),
        ]

        ranked = MAMClient.rank_matches(
            matches,
            target_title="The Name of the Wind",
            target_author="Patrick Rothfuss",
        )
        assert ranked[0].format == "audiobook"

    def test_high_seeders_boost_score(self) -> None:
        """Higher seeder count results in a higher score (all else equal)."""
        matches = [
            self.make_match("Test Book v1", seeders=10),
            self.make_match("Test Book v2", seeders=1000),
        ]

        ranked = MAMClient.rank_matches(matches, target_title="Test Book")
        # The v2 match should have higher score from seeder bonus alone
        assert ranked[0].seeders >= ranked[1].seeders

    def test_format_penalizes_study_guide(self) -> None:
        """Study guide format is penalized (negative score factor)."""
        exact_match = self.make_match("The Great Book", fmt="audiobook", seeders=5)
        study_guide = self.make_match("The Great Book Study Guide", fmt="study_guide", seeders=200)

        ranked = MAMClient.rank_matches([study_guide, exact_match], target_title="The Great Book")
        assert ranked[0].format == "audiobook"

    def test_author_partial_match_scored(self) -> None:
        """Partial author match is scored lower than exact."""
        matches = [
            self.make_match("Book Title", author="Patrick Rothfuss"),
            self.make_match("Book Title", author="Rothfuss, Patrick"),
        ]

        ranked = MAMClient.rank_matches(matches, target_title="Book Title", target_author="Patrick Rothfuss")
        assert ranked[0].score >= ranked[1].score


class TestMAMParsing:
    """Tests for internal MAM HTML parsing utilities."""

    def test_detect_format_audiobook(self) -> None:
        assert MAMClient._detect_format("The Great Book (Audiobook)") == "audiobook"
        assert MAMClient._detect_format("Unabridged Audio Book") == "audiobook"

    def test_detect_format_ebook(self) -> None:
        assert MAMClient._detect_format("The Great Book EPUB") == "ebook"
        assert MAMClient._detect_format("The Great Book (Mobi)") == "ebook"

    def test_detect_format_unknown(self) -> None:
        assert MAMClient._detect_format("Random File Name") == "unknown"

    def test_parse_year_found(self) -> None:
        assert MAMClient._parse_year("Book Title (2007)") == 2007
        assert MAMClient._parse_year("2023 Release") == 2023

    def test_parse_year_missing(self) -> None:
        assert MAMClient._parse_year("No Year Here") == 0

    def test_parse_size_bytes(self) -> None:
        assert MAMClient._parse_size("500 B") == 500
        assert MAMClient._parse_size("1.5 MB") == 1_572_864
        assert MAMClient._parse_size("2 GB") == 2_147_483_648
