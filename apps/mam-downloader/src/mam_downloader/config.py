from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # MAM
    mam_base_url: str = "https://www.myanonamouse.net"
    mam_username: str = ""
    mam_password: str = ""

    # qBittorrent
    qbittorrent_url: str = ""
    qbittorrent_username: str = ""
    qbittorrent_password: str = ""

    # Audiobookshelf
    abs_url: str = ""
    abs_api_key: str = ""

    # Paths
    download_path: str = "/data/media/audiobooks"
    config_path: str = "/config"

    # Mode
    dry_run: bool = False
