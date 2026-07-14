# Known Limitations — v1 (2026-07-14)

## MAM Session Expiry

MAM login sessions are maintained in-memory via cookie jar. If the MAM server invalidates the session (e.g. due to server restart, concurrent login elsewhere, or prolonged inactivity), subsequent API calls will return a login page instead of search results. The service does **not** detect or recover from session expiry automatically in v1.

**Mitigation:** Restart the container to force a fresh login. A periodic session-health check and automatic re-login is planned for v2.

## No Ongoing Download Monitoring

Once a torrent is queued in qBittorrent, the download manager polls for completion with a timeout. If the download stalls or is paused in qBittorrent, the manager will time out and mark the job as `failed`. There is no background watcher that resumes stalled downloads or handles qBittorrent queue re-ordering.

**Mitigation:** Monitor qBittorrent directly for long-running or stalled downloads. v2 may add webhook-based completion from qBittorrent.

## In-Memory Job State

Job state (status, progress, error messages) is stored in an in-memory `dict`. Restarting the service loses all non-terminal jobs. Completed/failed jobs in the download history (`/config/downloaded.json`) are **not** lost — only in-flight jobs are discarded.

**Mitigation:** v2 should persist job state to a SQLite database.

## Single-Instance Design

There is no job queue (e.g. Celery, Redis queue). Consecutive requisitions run sequentially in the event loop — a long download blocks the next search from starting.

**Mitigation:** Keep requisitions serial for now. v2 may add a proper task queue.

## ABS Folder Structure Heuristic

The organizer applies a best-effort `{Author}/{Series?}/{Title}/` folder layout by inspecting the torrent file list and metadata. Unusual naming conventions (series as separate top-level directories, missing author tags in filenames) may produce incorrect paths. Always verify the organized output after first use.

## Credential Management

Credentials are injected via environment variables (referenced through 1Password CLI or manually). There is no built-in secrets vault integration.

## No ISBN Auto-Lookup

If only an ISBN is provided, the service searches MAM by ISBN directly. If MAM has no entry indexed by ISBN, the search will return zero results. There is no external ISBN-to-title/author resolver in v1.
