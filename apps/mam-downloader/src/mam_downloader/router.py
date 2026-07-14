from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, HTTPException

from mam_downloader.config import Settings
from mam_downloader.models import BookRequisition, Job, JobStatus
from mam_downloader.services.download_manager import DownloadManager

logger = logging.getLogger(__name__)

# In-memory job store (v1: non-persistent)
_jobs: dict[str, Job] = {}


def create_router(settings: Settings) -> APIRouter:
    """Create the FastAPI router with all endpoints."""
    router = APIRouter()

    @router.post("/requisitions", status_code=202)
    async def submit_requisition(book: BookRequisition) -> dict:
        """Submit a book requisition. Returns a job tracking ID."""
        # Validate that at least one search field is provided
        if not book.title and not book.author and not book.isbn:
            raise HTTPException(
                status_code=422,
                detail="At least one of title, author, or isbn must be provided",
            )

        job = Job.create(book)
        _jobs[job.id] = job

        # Start background processing (fire-and-forget in v1)
        import asyncio

        dm = DownloadManager(settings)
        # Use asyncio.create_task for non-blocking background execution
        asyncio.ensure_future(_process_job(job, dm))

        return {"job_id": job.id, "status": job.status.value}

    @router.get("/jobs/{job_id}")
    async def get_job_status(job_id: str) -> dict:
        """Get the current status of a download job."""
        job = _jobs.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Job not found")

        return {
            "job_id": job.id,
            "status": job.status.value,
            "book": job.book.model_dump(exclude_none=True) if job.book else None,
            "torrent": job.torrent.model_dump(exclude_none=True) if job.torrent else None,
            "progress": job.progress,
            "error": job.error or None,
        }

    @router.get("/health")
    async def health() -> dict:
        """Health check endpoint."""
        return {"status": "ok"}

    return router


async def _process_job(job: Job, dm: DownloadManager) -> None:
    """Background task to process a download job."""
    try:
        await dm.execute(job)
    except Exception as exc:
        logger.exception("Background job %s failed unexpectedly", job.id)
        job.status = JobStatus.failed
        job.error = str(exc)
