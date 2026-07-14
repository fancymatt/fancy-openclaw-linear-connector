from __future__ import annotations

import uuid
from enum import Enum
from typing import Optional

from pydantic import BaseModel, field_validator


class JobStatus(str, Enum):
    searching = "searching"
    downloading = "downloading"
    importing = "importing"
    available = "available"
    failed = "failed"


class BookRequisition(BaseModel):
    title: str = ""
    author: str = ""
    isbn: str = ""

    @field_validator("title", "author", "isbn")
    @classmethod
    def strip_whitespace(cls, v: str) -> str:
        return v.strip()

    @field_validator("title")
    @classmethod
    def title_or_isbn_required(cls, v: str, info) -> str:
        data = info.data
        if not v and not data.get("author") and not data.get("isbn"):
            raise ValueError("At least one of title, author, or isbn must be provided")
        return v


class TorrentMatch(BaseModel):
    title: str
    author: str = ""
    year: int = 0
    format: str = "unknown"
    seeders: int = 0
    peers: int = 0
    size_bytes: int = 0
    torrent_url: str = ""
    score: float = 0.0


class Job(BaseModel):
    id: str = ""
    status: JobStatus = JobStatus.searching
    book: BookRequisition
    torrent: Optional[TorrentMatch] = None
    progress: float = 0.0
    error: str = ""

    @classmethod
    def create(cls, book: BookRequisition) -> Job:
        return cls(
            id=str(uuid.uuid4()),
            status=JobStatus.searching,
            book=book,
        )


class DownloadRecord(BaseModel):
    torrent_id: str
    title: str
    author: str = ""
    isbn: str = ""
    path: str = ""
    timestamp: str = ""
