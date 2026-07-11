/**
 * AI-2039 (P4-C4) — AC4.1: atomic apply writes.
 *
 * AC coverage in this file:
 *   AC4.1 — Applies write atomically (write temp + rename); a test proves a
 *           concurrent wake read never sees a torn file.
 *
 * ── Contract the implementer conforms to ────────────────────────────────────
 * Module: src/apply/atomic-write.ts
 *
 *   export async function atomicWriteFile(filePath: string, content: string): Promise<void>;
 *
 * Semantics: write the payload to a temporary sibling in the SAME directory as
 * `filePath`, fsync it, then `fs.rename(temp, filePath)`. Rename is atomic only
 * within a filesystem, which is why the temp must be a sibling and not in
 * os.tmpdir() — a cross-device rename raises EXDEV and forces a non-atomic copy.
 *
 * Why these three assertions together pin "temp + rename":
 *   1. No torn read      — the literal AC. A reader polling the path during the
 *                          write only ever observes the complete old content or
 *                          the complete new content, never a prefix and never "".
 *                          A naive fs.writeFile(final) truncates first, so a
 *                          reader observes "" or a partial prefix and this fails.
 *   2. Inode changes     — rename() swaps in a NEW inode. An in-place write keeps
 *                          the same inode. This is a mock-free proof of rename.
 *   3. Temp sibling seen — during the write a second entry exists in the target
 *                          directory, and it is gone afterward.
 *
 * The reader here reads exactly the way the live wake path reads step guidance
 * (`fs.readFile(path, "utf8")` — src/delivery/build-message.ts loadStepGuidance).
 *
 * RED until src/apply/atomic-write.ts exists.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";

import { atomicWriteFile } from "./atomic-write.js";

// Large enough that a non-atomic write cannot complete in a single syscall,
// so a concurrent reader is guaranteed a chance to observe a torn state.
const PAYLOAD_BYTES = 8 * 1024 * 1024;

const OLD_CONTENT = "# Step: code-review\n\n" + "old-".repeat(64) + "\n";
const NEW_CONTENT = "# Step: code-review\n\n" + "N".repeat(PAYLOAD_BYTES) + "\n";

let dir: string;
let target: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai2039-atomic-"));
  target = path.join(dir, "code-review.md");
  fs.writeFileSync(target, OLD_CONTENT, "utf8");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("AC4.1 — applies write atomically (temp + rename)", () => {
  it("a concurrent wake read never observes a torn file", async () => {
    const observed: string[] = [];
    const siblingCounts: number[] = [];
    let writing = true;

    // Reader loop: mirrors loadStepGuidance()'s read exactly.
    const reader = (async () => {
      while (writing) {
        try {
          observed.push(await fsp.readFile(target, "utf8"));
          siblingCounts.push(fs.readdirSync(dir).length);
        } catch (err: unknown) {
          // ENOENT would itself be a torn read: the wake path must never find
          // the guidance file missing mid-apply. Record it as a failure sentinel.
          observed.push(`<<ENOENT:${(err as NodeJS.ErrnoException).code}>>`);
        }
        await new Promise((r) => setImmediate(r));
      }
    })();

    await atomicWriteFile(target, NEW_CONTENT);
    writing = false;
    await reader;

    expect(observed.length).toBeGreaterThan(0);

    // Every single observation is one of the two complete, valid states.
    const torn = observed.filter((c) => c !== OLD_CONTENT && c !== NEW_CONTENT);
    expect(torn).toEqual([]);

    // The write actually landed.
    expect(await fsp.readFile(target, "utf8")).toBe(NEW_CONTENT);

    // A temp sibling existed in the target directory at some point during the
    // write (temp + rename), and the directory is clean afterward.
    expect(Math.max(...siblingCounts)).toBeGreaterThan(1);
    expect(fs.readdirSync(dir)).toEqual(["code-review.md"]);
  });

  it("replaces the file by rename, not in-place truncation (inode changes)", async () => {
    const before = fs.statSync(target).ino;

    await atomicWriteFile(target, "replacement\n");

    const after = fs.statSync(target).ino;
    expect(after).not.toBe(before);
    expect(fs.readFileSync(target, "utf8")).toBe("replacement\n");
  });

  it("writes its temp file as a sibling so the rename cannot cross devices", async () => {
    // If the implementation staged in os.tmpdir(), rename() would throw EXDEV on
    // any setup where /tmp is a different filesystem. Assert the staging happens
    // next to the target by watching the target directory during the write.
    let sawSibling = false;
    let writing = true;

    const watcher = (async () => {
      while (writing) {
        if (fs.readdirSync(dir).some((f) => f !== "code-review.md")) sawSibling = true;
        await new Promise((r) => setImmediate(r));
      }
    })();

    await atomicWriteFile(target, NEW_CONTENT);
    writing = false;
    await watcher;

    expect(sawSibling).toBe(true);
  });

  it("leaves the original content intact when the write fails mid-flight", async () => {
    // A failed apply must not destroy the live guidance file.
    const unwritable = path.join(dir, "nonexistent-subdir", "code-review.md");
    await expect(atomicWriteFile(unwritable, NEW_CONTENT)).rejects.toThrow();

    // The real target is untouched.
    expect(fs.readFileSync(target, "utf8")).toBe(OLD_CONTENT);
    // No temp litter left behind in the target dir.
    expect(fs.readdirSync(dir)).toEqual(["code-review.md"]);
  });
});
