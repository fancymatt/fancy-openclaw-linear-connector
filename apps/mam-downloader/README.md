# MAM Audiobook Downloader

A FastAPI microservice that automates audiobook acquisition from MyAnonamouse (MAM): search for a book, queue the best-match torrent in qBittorrent, organize the completed download into an Audiobookshelf-friendly folder structure, and trigger a library scan.

## Architecture

```
┌──────────┐    POST /requisitions    ┌────────────────┐
│  Client  │ ────────────────────────▶ │  MAM Downloader │
│  (curl/  │ ◀──────────────────────── │  (FastAPI :8687)│
│  script) │    GET /jobs/{id}        └───────┬────────┘
                                              │
                    ┌─────────────────────────┼──────────────────┐
                    │                         │                   │
                    ▼                         ▼                   ▼
             ┌──────────┐           ┌──────────────┐    ┌──────────────┐
             │  MAM     │           │  qBittorrent  │    │Audiobookshelf │
             │  Search  │           │  Download     │    │  Library Scan │
             └──────────┘           └──────────────┘    └──────────────┘
```

## Quickstart

### Prerequisites

- Python 3.12+
- qBittorrent instance with WebUI enabled
- Audiobookshelf instance with API key
- MAM account

### Configuration

All configuration is via environment variables:

| Variable | Required | Default | Description |
|---|---|---|---|
| `MAM_BASE_URL` | No | `https://www.myanonamouse.net` | MAM base URL |
| `MAM_USERNAME` | **Yes** | — | MAM login email |
| `MAM_PASSWORD` | **Yes** | — | MAM login password |
| `QBITTORRENT_URL` | **Yes** | — | qBittorrent WebUI URL |
| `QBITTORRENT_USERNAME` | No | — | qBittorrent username |
| `QBITTORRENT_PASSWORD` | No | — | qBittorrent password |
| `ABS_URL` | **Yes** | — | Audiobookshelf URL |
| `ABS_API_KEY` | **Yes** | — | Audiobookshelf API token |
| `DOWNLOAD_PATH` | No | `/data/media/audiobooks` | Base audiobooks directory |
| `CONFIG_PATH` | No | `/config` | Config & download history path |
| `DRY_RUN` | No | `false` | If `true`, never enqueue torrents |

### Running

```bash
# Install
pip install .

# Start server
MAM_USERNAME=... MAM_PASSWORD=... \
QBITTORRENT_URL=http://... QBITTORRENT_USERNAME=... QBITTORRENT_PASSWORD=... \
ABS_URL=http://... ABS_API_KEY=... \
python -m mam_downloader --serve

# Dry-run search (no download)
python -m mam_downloader --dry-run --title "The Name of the Wind" --author "Patrick Rothfuss"
```

### Docker

```bash
docker compose up -d
```

See `docker-compose.yml` for environment variable configuration.

## API

### POST /requisitions

Submit a book requisition. Returns immediately with a job tracking ID.

```json
{
  "title": "The Name of the Wind",
  "author": "Patrick Rothfuss",
  "isbn": "9780756404741"
}
```

Response `202 Accepted`:
```json
{
  "job_id": "a1b2c3d4-...",
  "status": "searching"
}
```

### GET /jobs/{job_id}

Returns the current state of a download job.

```json
{
  "job_id": "a1b2c3d4-...",
  "status": "downloading",
  "book": {
    "title": "The Name of the Wind",
    "author": "Patrick Rothfuss"
  },
  "torrent": {
    "title": "Patrick Rothfuss - The Name of the Wind (Audiobook)",
    "score": 95,
    "torrent_url": "https://www.myanonamouse.net/torrents/...",
    "seeders": 42
  },
  "progress": 0.65,
  "error": null
}
```

### GET /health

Simple health check.

## Download History

Duplicate tracking is stored in `{CONFIG_PATH}/downloaded.json`. Each entry records the `torrent_id` and optionally the `isbn` to prevent re-downloading the same book.

## Folder Organization

Completed downloads are organized into:
```
{DOWNLOAD_PATH}/
  {Author}/
    {Series}/          ← if detected
      {Title}/
        {torrent files}
```

## Deployment

The included `docker-compose.yml` is written for Fujimoto (Synology NAS) but works anywhere with path adjustments.

### 1Password Integration

Credentials are referenced via `${VAR:?error}` in `docker-compose.yml`. On the host, inject them with 1Password CLI:

```bash
export MAM_USERNAME=$(op read "op://Personal/MAM/username")
export MAM_PASSWORD=$(op read "op://Personal/MAM/password")
# ... etc
docker compose up -d
```

Or use an `.env` file (not committed).

## Development

```bash
pip install -e ".[dev]"
pytest
```
