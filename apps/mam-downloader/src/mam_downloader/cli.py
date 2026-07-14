from __future__ import annotations

import argparse
import logging
import sys

from mam_downloader.config import Settings
from mam_downloader.models import BookRequisition, TorrentMatch
from mam_downloader.services.download_manager import DownloadManager
from mam_downloader.services.mam import (
    MAMClient,
)

logger = logging.getLogger(__name__)


def setup_logging(verbose: bool = False) -> None:
    """Configure logging."""
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
    )


def run_dry_run(settings: Settings, title: str, author: str, isbn: str) -> None:
    """Run a dry-run search and print ranked matches."""
    import asyncio

    async def _search() -> None:
        book = BookRequisition(title=title, author=author, isbn=isbn)
        dm = DownloadManager(settings)
        results = await dm.search_only(book)

        if not results:
            print("No matches found.")
            return

        print(f"\nFound {len(results)} match(es):")
        print(f"{'Score':>6}  {'Seeders':>7}  {'Format':<14}  {'Title'}")
        print("-" * 80)
        for match in results:
            print(
                f"{match.score:>6.1f}  "
                f"{match.seeders:>7}  "
                f"{match.format:<14}  "
                f"{match.title}"
            )
            if match.author:
                print(f"{'':>6}  {'':>7}  {'':<14}  Author: {match.author}")
            if match.year:
                print(f"{'':>6}  {'':>7}  {'':<14}  Year: {match.year}")

    asyncio.run(_search())


def run_server(settings: Settings) -> None:
    """Run the FastAPI server."""
    import uvicorn

    from mam_downloader.app import create_app

    app = create_app(settings)
    uvicorn.run(app, host="0.0.0.0", port=8687, log_level="info")


def main() -> None:
    """CLI entry point."""
    parser = argparse.ArgumentParser(
        description="MAM Audiobook Downloader — search, queue, organize, scan"
    )

    parser.add_argument(
        "--serve",
        action="store_true",
        help="Run the FastAPI server",
    )

    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Search MAM and show ranked matches without downloading",
    )

    parser.add_argument(
        "--title",
        type=str,
        default="",
        help="Book title to search for",
    )

    parser.add_argument(
        "--author",
        type=str,
        default="",
        help="Book author to search for",
    )

    parser.add_argument(
        "--isbn",
        type=str,
        default="",
        help="ISBN to search for",
    )

    parser.add_argument(
        "--verbose",
        "-v",
        action="store_true",
        help="Enable verbose logging",
    )

    parser.add_argument(
        "--env-file",
        type=str,
        default=".env",
        help="Path to .env file for configuration",
    )

    args = parser.parse_args()

    setup_logging(args.verbose)

    settings = Settings(_env_file=args.env_file)

    # Override dry_run from CLI flag
    if args.dry_run:
        settings.dry_run = True

    if args.serve:
        run_server(settings)
    elif args.dry_run:
        run_dry_run(settings, args.title, args.author, args.isbn)
    else:
        parser.print_help()
        sys.exit(1)
