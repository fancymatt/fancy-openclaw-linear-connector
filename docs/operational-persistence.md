# Operational Persistence

## What This Is

The SQLite database in `data/events.db` is **operational state** — bookkeeping for webhook deduplication and restart safety.

## What This Is NOT

This is **not business truth**. Linear is the source of truth for issue state, comments, and assignments. The event store only records which webhook deliveries have already been processed to prevent duplicate work.

## Safe to Delete

The database can be deleted at any time. The only consequence is that webhook events already processed may be re-processed if Linear retries them. No data is lost — Linear retains all authoritative state.

## What's Stored

| Column     | Purpose                                      |
|------------|----------------------------------------------|
| event_id   | Unique webhook delivery ID (dedup key)       |
| payload    | JSON snapshot for debugging / restart replay |
| status     | Processing status (`processed`)              |
| created_at | When the event was first recorded            |
| updated_at | Last modification timestamp                  |

## Implementation

- **Engine:** SQLite via `better-sqlite3` (WAL mode for concurrent reads)
- **Location:** `data/events.db` (auto-created on first use)
- **Dedup strategy:** `INSERT OR IGNORE` on the event ID primary key
