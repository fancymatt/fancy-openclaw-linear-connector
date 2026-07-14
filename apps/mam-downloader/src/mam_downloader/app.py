from __future__ import annotations

import logging

from fastapi import FastAPI, APIRouter

from mam_downloader.config import Settings
from mam_downloader.router import create_router

logger = logging.getLogger(__name__)


def create_app(settings: Settings | None = None) -> FastAPI:
    """Create and configure the FastAPI application."""
    if settings is None:
        settings = Settings()

    app = FastAPI(
        title="MAM Downloader",
        description="MyAnonamouse audiobook downloader pipeline",
        version="0.1.0",
    )

    # Store settings in app state
    app.state.settings = settings

    # Register routes
    router = create_router(settings)
    app.include_router(router)

    # Shutdown handler
    @app.on_event("shutdown")
    async def shutdown() -> None:
        logger.info("Shutting down MAM Downloader")

    return app
