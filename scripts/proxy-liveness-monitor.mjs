#!/usr/bin/env node
/**
 * AI-1559 / Gap G-15(b) — EXTERNAL proxy liveness monitor (runner).
 *
 * Runs as a separate, short-lived process under a systemd user timer — NOT
 * inside the connector/proxy — so it can detect and alert on a dead proxy that
 * cannot alert on itself. One invocation = one probe + one state transition.
 *
 * Pure decision logic lives in ../dist/proxy-liveness.js (unit-tested). This
 * runner owns only I/O: load state, probe /health, persist state, deliver alert.
 *
 * Alert delivery is intentionally independent of BOTH the proxy AND the gateway:
 * it resolves the Telegram bot token via the canonical 1Password provider
 * (needs only OP_SERVICE_ACCOUNT_TOKEN) and POSTs straight to the Telegram Bot
 * API. It also appends a durable record to infra-issues.md and the journal, so
 * even if Telegram delivery fails the outage still leaves a visible trail.
 *
 * Config (env):
 *   PROXY_HEALTH_URL          default http://localhost:3100/health
 *   PROXY_LIVENESS_STATE_FILE default $HOME/.local/state/linear-proxy-liveness.json
 *   PROXY_LIVENESS_ALERT_TARGET default -1003813031816 (Ai main TG group)
 *   PROXY_LIVENESS_TG_THREAD_ID optional forum topic id (omit = General)
 *   PROXY_LIVENESS_TG_TOKEN_ID  default ai606_config_channels_telegram_accounts_default_botToken
 *   PROXY_LIVENESS_OP_PROVIDER  default $HOME/.openclaw/bin/openclaw-op-secret-provider
 *   PROXY_LIVENESS_FAILURE_THRESHOLD default 3
 *   PROXY_LIVENESS_REMINDER_MS default 3600000
 *   PROXY_LIVENESS_INFRA_DOC  default obsidian infra-issues.md
 */

import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

import { evaluate, initialState, probeHealth } from "../dist/proxy-liveness.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOME ?? homedir();

const HEALTH_URL = process.env.PROXY_HEALTH_URL ?? "http://localhost:3100/health";
const STATE_FILE =
  process.env.PROXY_LIVENESS_STATE_FILE ??
  resolve(HOME, ".local/state/linear-proxy-liveness.json");
const ALERT_TARGET = process.env.PROXY_LIVENESS_ALERT_TARGET ?? "-1003813031816";
const TG_THREAD_ID = process.env.PROXY_LIVENESS_TG_THREAD_ID; // optional
const TG_TOKEN_ID =
  process.env.PROXY_LIVENESS_TG_TOKEN_ID ??
  "ai606_config_channels_telegram_accounts_default_botToken";
const OP_PROVIDER =
  process.env.PROXY_LIVENESS_OP_PROVIDER ??
  resolve(HOME, ".openclaw/bin/openclaw-op-secret-provider");
const FAILURE_THRESHOLD = Number.parseInt(
  process.env.PROXY_LIVENESS_FAILURE_THRESHOLD ?? "3",
  10,
);
const REMINDER_MS = Number.parseInt(
  process.env.PROXY_LIVENESS_REMINDER_MS ?? String(60 * 60 * 1000),
  10,
);
const INFRA_DOC =
  process.env.PROXY_LIVENESS_INFRA_DOC ??
  resolve(HOME, "obsidian-vault/ai-systems/areas/infra/infra-issues.md");

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return initialState();
  }
}

function saveState(state) {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function log(line) {
  // Goes to the systemd journal.
  process.stdout.write(`[proxy-liveness] ${line}\n`);
}

function resolveBotToken() {
  // Allow a direct override (e.g. for tests) but default to the canonical
  // 1Password provider so we never hardcode the secret.
  if (process.env.PROXY_LIVENESS_TG_BOT_TOKEN) {
    return process.env.PROXY_LIVENESS_TG_BOT_TOKEN;
  }
  const res = spawnSync(OP_PROVIDER, [], {
    encoding: "utf8",
    timeout: 30_000,
    input: JSON.stringify({ provider: "onepassword", ids: [TG_TOKEN_ID] }),
  });
  if (res.status !== 0) {
    log(`token resolve FAILED (status=${res.status}): ${(res.stderr || res.error?.message || "").slice(0, 200)}`);
    return null;
  }
  try {
    const parsed = JSON.parse(res.stdout);
    const token = parsed?.values?.[TG_TOKEN_ID];
    if (!token) {
      log(`token resolve returned no value; errors=${JSON.stringify(parsed?.errors ?? {})}`);
      return null;
    }
    return token;
  } catch (err) {
    log(`token resolve parse error: ${err}`);
    return null;
  }
}

async function deliverTelegram(message) {
  const token = resolveBotToken();
  if (!token) {
    log("telegram delivery SKIPPED — could not resolve bot token");
    return false;
  }
  const payload = { chat_id: ALERT_TARGET, text: message, disable_web_page_preview: true };
  if (TG_THREAD_ID) payload.message_thread_id = Number.parseInt(TG_THREAD_ID, 10);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      log(`alert delivered to telegram ${ALERT_TARGET}`);
      return true;
    }
    const body = await res.text().catch(() => "");
    log(`telegram delivery FAILED (HTTP ${res.status}): ${body.slice(0, 300)}`);
    return false;
  } catch (err) {
    log(`telegram delivery error: ${err}`);
    return false;
  }
}

function appendInfraDoc(message) {
  try {
    if (!existsSync(INFRA_DOC)) return;
    const stamp = new Date().toISOString();
    appendFileSync(INFRA_DOC, `\n- **[${stamp}] proxy-liveness:** ${message}\n`);
  } catch (err) {
    log(`infra-doc append failed: ${err}`);
  }
}

async function fireAlert(action, detail) {
  const emoji = action === "alert-recovered" ? "✅" : "🚨";
  const headline =
    action === "alert-recovered"
      ? "Linear connector/proxy RECOVERED — /health is responding again."
      : action === "alert-reminder"
        ? "Linear connector/proxy STILL DOWN."
        : "Linear connector/proxy is DOWN — the fleet is fail-closed (no agent can reach Linear).";
  const message = `${emoji} ${headline}\nendpoint: ${HEALTH_URL}\ndetail: ${detail}`;
  log(headline);
  // Durable record first — guaranteed even if Telegram delivery fails.
  appendInfraDoc(`${headline} (${detail})`);
  await deliverTelegram(message);
}

async function main() {
  const prev = loadState();
  const probe = await probeHealth(HEALTH_URL);
  const { next, action } = evaluate(prev, probe.ok, Date.now(), {
    failureThreshold: FAILURE_THRESHOLD,
    reminderIntervalMs: REMINDER_MS,
  });
  saveState(next);

  log(`probe ok=${probe.ok} (${probe.detail}); status=${next.status} fails=${next.consecutiveFailures} action=${action}`);

  if (action !== "none") {
    await fireAlert(action, probe.detail);
  }

  // Non-zero exit while down makes the failure visible in `systemctl --user status`.
  process.exit(next.status === "down" ? 1 : 0);
}

main().catch((err) => {
  log(`monitor crashed: ${err?.stack ?? err}`);
  process.exit(2);
});
