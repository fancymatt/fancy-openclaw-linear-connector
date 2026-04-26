/**
 * Interactive CLI wizard for onboarding a new agent into the Linear connector.
 * Replaces the manual 9-step process from the README.
 *
 * Usage: npm run onboard
 */
import * as readline from "node:readline";
import { execSync } from "node:child_process";
import { getAgent, upsertAgent } from "./agents.js";
// ── ANSI helpers ──────────────────────────────────────────────────────────────
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";
function bold(text) { return BOLD + text + RESET; }
function dim(text) { return DIM + text + RESET; }
function green(text) { return GREEN + text + RESET; }
function yellow(text) { return YELLOW + text + RESET; }
function cyan(text) { return CYAN + text + RESET; }
function red(text) { return RED + text + RESET; }
function heading(text) {
    console.log("\n" + BOLD + CYAN + "━━━ " + text + " ━━━" + RESET + "\n");
}
function info(text) {
    console.log("  " + text);
}
function success(text) {
    console.log("  " + green("✔") + " " + text);
}
function warn(text) {
    console.log("  " + yellow("⚠") + " " + text);
}
function step(num, text) {
    console.log("\n  " + BOLD + "[Step " + num + "]" + RESET + " " + text);
}
// ── readline helpers ──────────────────────────────────────────────────────────
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});
function prompt(question) {
    return new Promise((resolve) => {
        rl.question("  " + question + ": ", (answer) => {
            resolve(answer.trim());
        });
    });
}
function promptDefault(question, defaultValue) {
    const suffix = dim("[" + defaultValue + "]");
    return new Promise((resolve) => {
        rl.question("  " + question + " " + suffix + ": ", (answer) => {
            resolve(answer.trim() || defaultValue);
        });
    });
}
function confirmPrompt(question) {
    const suffix = dim("[y/N]");
    return new Promise((resolve) => {
        rl.question("  " + question + " " + suffix + ": ", (answer) => {
            const a = answer.trim().toLowerCase();
            resolve(a === "y" || a === "yes");
        });
    });
}
// ── Main wizard ───────────────────────────────────────────────────────────────
async function main() {
    console.log("\n" + BOLD + CYAN + "╔══════════════════════════════════════════════╗" + RESET);
    console.log(BOLD + CYAN + "║   Linear Connector — Agent Onboard Wizard    ║" + RESET);
    console.log(BOLD + CYAN + "╚══════════════════════════════════════════════╝" + RESET);
    // ── Step 1: Agent name ──────────────────────────────────────────────────
    heading("Agent Identity");
    const agentName = await prompt("Internal agent name (e.g. sakura, charles)");
    if (!agentName) {
        console.log(red("\n  Agent name is required. Exiting."));
        rl.close();
        process.exit(1);
    }
    // Validate: lowercase, no spaces, alphanumeric + hyphens
    if (!/^[a-z][a-z0-9-]*$/.test(agentName)) {
        console.log(red("\n  Invalid name \"" + agentName + "\". Use lowercase letters, numbers, and hyphens. Must start with a letter."));
        rl.close();
        process.exit(1);
    }
    // ── Step 2: Display name ───────────────────────────────────────────────
    const displayName = await prompt("Display name in Linear (e.g. \"Sakura (Translator)\")");
    if (!displayName) {
        console.log(red("\n  Display name is required. Exiting."));
        rl.close();
        process.exit(1);
    }
    // ── Step 3: OpenClaw agent name ─────────────────────────────────────────
    const openclawAgent = await promptDefault("OpenClaw agent name", agentName);
    // ── Step 4: Check existing ──────────────────────────────────────────────
    const existing = getAgent(agentName);
    if (existing) {
        const hasTokens = existing.accessToken && existing.linearUserId;
        console.log("\n  " + yellow("⚠") + " Agent \"" + agentName + "\" already exists in agents.json.");
        if (hasTokens) {
            info("    linearUserId: " + existing.linearUserId);
            info("    has tokens: yes");
        }
        else {
            info("    has tokens: no (partial entry)");
        }
        const overwrite = await confirmPrompt("Overwrite this agent's config?");
        if (!overwrite) {
            console.log(dim("\n  Cancelled. No changes made."));
            rl.close();
            process.exit(0);
        }
    }
    // ── Step 5: Determine redirect URI ──────────────────────────────────────
    heading("Connector URL");
    let redirectUri = process.env.OAUTH_REDIRECT_URI;
    if (!redirectUri) {
        redirectUri = await prompt("Full callback URL (e.g. https://ai.fcy.sh/linear-webhook/callback)");
        if (!redirectUri) {
            console.log(red("\n  Redirect URI is required. Exiting."));
            rl.close();
            process.exit(1);
        }
    }
    else {
        info("Using OAUTH_REDIRECT_URI from env: " + cyan(redirectUri));
    }
    // ── Step 6: Guide through Linear UI ────────────────────────────────────
    heading("Create OAuth App in Linear");
    console.log("  Follow these steps in the " + bold("Linear UI") + ":\n");
    console.log("  1. Go to: " + cyan("https://linear.app/settings/api/applications/new"));
    console.log("     " + dim("(Settings → API → Applications → Create new)") + "\n");
    console.log("  2. Set the name to: " + bold(displayName));
    console.log("     " + dim("(This is how the agent appears in Linear — mention menu, delegate dropdown, comments)") + "\n");
    console.log("  3. Set the redirect URI to:");
    console.log("     " + cyan(redirectUri) + "\n");
    console.log("  4. Enable these scopes:");
    console.log("     " + green("✓") + " read");
    console.log("     " + green("✓") + " write");
    console.log("     " + green("✓") + " app:assignable  " + dim("(appears as delegate)"));
    console.log("     " + green("✓") + " app:mentionable  " + dim("(can be @mentioned)") + "\n");
    console.log("  5. " + bold("Copy the Client ID and Client Secret") + " — you'll paste them next.");
    const ready = await confirmPrompt("\n  Done? Have your Client ID and Client Secret ready?");
    if (!ready) {
        console.log(dim("\n  No problem. Run the wizard again when you're ready."));
        rl.close();
        process.exit(0);
    }
    // ── Step 7: Collect credentials ─────────────────────────────────────────
    heading("OAuth Credentials");
    const clientId = await prompt("Client ID");
    if (!clientId) {
        console.log(red("\n  Client ID is required. Exiting."));
        rl.close();
        process.exit(1);
    }
    const clientSecret = await prompt("Client Secret");
    if (!clientSecret) {
        console.log(red("\n  Client Secret is required. Exiting."));
        rl.close();
        process.exit(1);
    }
    // ── Step 8: Write partial entry ─────────────────────────────────────────
    step(8, "Writing partial agent entry to agents.json...");
    const partialConfig = {
        name: agentName,
        linearUserId: existing?.linearUserId ?? "",
        clientId,
        clientSecret,
        accessToken: existing?.accessToken ?? "",
        refreshToken: existing?.refreshToken ?? "",
        openclawAgent,
        host: existing?.host ?? "local",
    };
    upsertAgent(partialConfig);
    success("Partial entry for \"" + agentName + "\" written to agents.json");
    // ── Step 9: Build authorize URL ─────────────────────────────────────────
    heading("Authorize the Agent");
    const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "read,write,app:assignable,app:mentionable",
        actor: "app",
        state: agentName,
    });
    const authorizeUrl = "https://linear.app/oauth/authorize?" + params.toString();
    console.log("\n  Open this URL in your browser to authorize the agent:");
    console.log("\n  " + cyan(authorizeUrl) + "\n");
    warn("You MUST see \"Install App\" — NOT a personal login screen.");
    info("If you see your own name instead, the URL is wrong.");
    info("The page should say \"Install " + displayName + "\" with app permissions.\n");
    // Try to open in browser
    try {
        const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
        execSync(cmd + " \"" + authorizeUrl + "\"", { stdio: "ignore", timeout: 3000 });
        success("Opened in browser automatically.");
    }
    catch {
        info(dim("(Could not auto-open browser. Copy the URL above manually.)"));
    }
    // ── Step 10: Wait for confirmation ──────────────────────────────────────
    console.log();
    const approved = await confirmPrompt("Did you approve the authorization in the browser?");
    if (!approved) {
        console.log(dim("\n  No worries. The partial entry is saved in agents.json."));
        info("When you're ready, open the authorize URL above to complete setup.");
        info("The connector will fill in tokens automatically via the callback.");
        rl.close();
        process.exit(0);
    }
    // ── Step 11: Verify completion ──────────────────────────────────────────
    heading("Verification");
    // Re-read from agents.json (the callback handler writes via upsertAgent)
    const verify = getAgent(agentName);
    if (!verify) {
        console.log(red("\n  Agent \"" + agentName + "\" not found in agents.json. Something went wrong."));
        rl.close();
        process.exit(1);
    }
    if (verify.accessToken && verify.linearUserId) {
        success("Agent \"" + agentName + "\" is fully configured!");
        info("  linearUserId: " + verify.linearUserId);
        info("  has tokens: yes");
        info("  openclawAgent: " + (verify.openclawAgent ?? agentName));
        console.log("\n  " + green("The connector will pick up this agent automatically. No restart needed."));
        console.log("  " + dim("Test by delegating a Linear issue to the agent."));
    }
    else {
        warn("Agent \"" + agentName + "\" exists but is missing tokens.");
        info("This usually means the OAuth callback hasn't completed yet.");
        info("Check that the connector is running and reachable at the callback URL.");
        info("You can re-run the authorize URL to retry:");
        console.log("\n  " + cyan(authorizeUrl));
    }
    // ── Done ────────────────────────────────────────────────────────────────
    console.log("\n" + BOLD + CYAN + "━━━ Wizard Complete ━━━" + RESET + "\n");
    rl.close();
}
main().catch((err) => {
    console.error(red("\n  Unexpected error: " + (err instanceof Error ? err.message : String(err))));
    rl.close();
    process.exit(1);
});
//# sourceMappingURL=onboard-wizard.js.map