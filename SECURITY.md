# Security

This document describes the security model for credential storage in the Linear connector and the available upgrade paths.

## What's Stored

The connector stores per-agent OAuth credentials in `agents.json` (located in the connector working directory):

| Field | Description |
|-------|-------------|
| `clientId` | Linear OAuth app client ID (semi-public — identifies the app) |
| `clientSecret` | Linear OAuth app client secret (**sensitive**) |
| `accessToken` | OAuth access token, auto-refreshed every ~20h (**sensitive**, short-lived) |
| `refreshToken` | OAuth refresh token, used to obtain new access tokens (**sensitive**, long-lived) |
| `linearUserId`, `openclawAgent`, `secretsPath`, `host`, `name` | Non-secret configuration |

Additionally, on each token refresh, the access token is written to the path specified in `secretsPath` (typically `~/.openclaw/workspace-<agent>/.secrets/linear.env`) so the `linear` CLI skill can read it.

## Security Boundary

**The host machine is the security boundary.** This is the same model used by SSH keys (`~/.ssh/`), `.env` files, Docker secrets, and most CLI tool credential stores.

- `agents.json` is created with owner-only permissions (`0o600`) — only the user running the connector can read it
- `agents.json` is excluded from version control via `.gitignore`
- The `secretsPath` files are also `0o600`

### Threats This Model Handles

- Other users on the same machine cannot read credentials (filesystem permissions)
- Credentials are not exposed in version control or CI pipelines

### Threats This Model Does NOT Handle

- **Backup/snapshot leakage** — disk backups don't enforce per-file permissions; `agents.json` could end up in a tarball, VM snapshot, or rsync to a less-secure destination
- **Host compromise** — if an attacker gains access to the user account, they can read credentials from disk or process memory. No software-level mitigation exists for this.
- **Network attacks** — already mitigated by HTTPS for all Linear API calls and HMAC signature verification for incoming webhooks

## Best Practices

1. **Restrict user access** — the connector should run under a dedicated service account, not a shared user
2. **Encrypt filesystem** — LUKS or equivalent disk encryption prevents credential extraction from physical media
3. **Secure backups** — exclude `agents.json` and `data/` from backups, or encrypt backup destinations
4. **Use systemd** — run as a systemd service with `EnvironmentFile=` for secrets (keeps them out of process args visible in `ps`)
5. **Rotate credentials** — if a host is compromised, rotate all OAuth client secrets in Linear and re-authorize all agents

## Upgrade Path

The connector supports a tiered credential storage model. Higher tiers provide stronger at-rest protection at the cost of additional configuration complexity.

| Tier | Method | External Dependencies | Effort |
|------|--------|-----------------------|--------|
| **1** | Plaintext with file permissions (current default) | None | None (this is the default) |
| **2** | AES-256-GCM encryption with key file | None | ~2h setup |
| **3** | OS keyring (libsecret / Keychain) | `libsecret` / macOS Keychain | ~1 day setup |
| **4** | Secrets manager (1Password, HashiCorp Vault, etc.) | Provider CLI tool | ~half-day per provider |

### Tier 2 — Key File Encryption

Set `LINEAR_CONNECTOR_ENCRYPTION_KEY` (or provide a key file path) and the connector will encrypt `agents.json` at rest. Auto-detection: if the key is present on startup, the file is decrypted; if absent, plaintext is used.

### Tier 3 — OS Keyring

Store credentials in the OS-native keyring. Falls back to Tier 2 if the keyring is unavailable (common on headless servers without a desktop session).

### Tier 4 — Secrets Manager

Pluggable provider interface. Set `LINEAR_CONNECTOR_STORE=1password` (or `vault`, `aws`, etc.) and configure the provider. 1Password (`op` CLI) is the first supported provider — see [TBD issue] for details.

**Configuration precedence** (highest to lowest):
1. `LINEAR_CONNECTOR_STORE` env var explicitly selects a provider
2. OS keyring availability check → Tier 3
3. Encryption key file present → Tier 2
4. Fall through to Tier 1 (plaintext; a warning is logged at startup)
