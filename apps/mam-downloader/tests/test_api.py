from __future__ import annotations

import json
from unittest.mock import ANY, AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from mam_downloader.models import BookRequisition, Job, JobStatus, TorrentMatch


class TestRequisitionsEndpoint:
    """Tests for POST /requisitions."""

    def test_submit_requisition_returns_202(self, app: TestClient) -> None:
        """POST /requisitions returns 202 with a job ID."""
        with patch("mam_downloader.router.DownloadManager") as MockDM:
            mock_instance = AsyncMock()
            MockDM.return_value = mock_instance

            response = app.post(
                "/requisitions",
                json={"title": "The Name of the Wind", "author": "Patrick Rothfuss"},
            )

            assert response.status_code == 202
            data = response.json()
            assert "job_id" in data
            assert data["status"] == "searching"

    def test_submit_requisition_returns_job_id(self, app: TestClient) -> None:
        """Job ID is a valid UUID string."""
        with patch("mam_downloader.router.DownloadManager"):
            response = app.post(
                "/requisitions",
                json={"title": "Test Book", "author": "Test Author"},
            )

            assert response.status_code == 202
            job_id = response.json()["job_id"]
            # UUID format: 8-4-4-4-12 hex chars
            assert len(job_id) == 36
            assert job_id.count("-") == 4

    def test_submit_without_title_author_returns_422(self, app: TestClient) -> None:
        """Missing all search fields returns 422."""
        response = app.post(
            "/requisitions",
            json={},
        )

        assert response.status_code == 422

    def test_submit_with_only_isbn_returns_202(self, app: TestClient) -> None:
        """ISBN-only requisition is accepted."""
        with patch("mam_downloader.router.DownloadManager"):
            response = app.post(
                "/requisitions",
                json={"isbn": "9780756404741"},
            )

            assert response.status_code == 202
            data = response.json()
            assert "job_id" in data


class TestJobsEndpoint:
    """Tests for GET /jobs/{job_id}."""

    def test_get_job_status_valid_id(self, app: TestClient) -> None:
        """GET /jobs/{valid_id} returns job status."""
        # First create a job
        with patch("mam_downloader.router.DownloadManager"):
            create_resp = app.post(
                "/requisitions",
                json={"title": "Test Book", "author": "Test Author"},
            )
            job_id = create_resp.json()["job_id"]

        # Then check status
        response = app.get(f"/jobs/{job_id}")
        assert response.status_code == 200
        data = response.json()
        assert data["job_id"] == job_id
        assert "status" in data
        assert data["book"]["title"] == "Test Book"

    def test_get_job_status_invalid_id(self, app: TestClient) -> None:
        """GET /jobs/{invalid_id} returns 404."""
        response = app.get("/jobs/nonexistent-id")
        assert response.status_code == 404
        assert "not found" in response.json()["detail"].lower()

    def test_job_lifecycle_through_status(
        self,
        app: TestClient,
        settings,
        sample_torrent_match: TorrentMatch,
    ) -> None:
        """Job status transitions through lifecycle."""
        with patch("mam_downloader.router.DownloadManager") as MockDM:
            mock_instance = AsyncMock()
            MockDM.return_value = mock_instance

            create_resp = app.post(
                "/requisitions",
                json={"title": "The Name of the Wind", "author": "Patrick Rothfuss"},
            )
            job_id = create_resp.json()["job_id"]

            # Simulate the background job running to completion
            # In test, we manually set the job state since background tasks
            # may not have run
            from mam_downloader.router import _jobs

            if job_id in _jobs:
                _jobs[job_id].status = JobStatus.available
                _jobs[job_id].progress = 1.0
                _jobs[job_id].torrent = sample_torrent_match

            resp = app.get(f"/jobs/{job_id}")
            assert resp.status_code == 200
            data = resp.json()
            assert data["status"] == "available"
            assert data["progress"] == 1.0
            assert data["torrent"] is not None


class TestHealthEndpoint:
    """Tests for GET /health."""

    def test_health_returns_200(self, app: TestClient) -> None:
        """GET /health returns 200 OK."""
        response = app.get("/health")
        assert response.status_code == 200
        assert response.json()["status"] == "ok"
