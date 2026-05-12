import { buildWakeUpMessage, SINGLE_TICKET_TEMPLATE, MULTI_TICKET_TEMPLATE } from "./wake-up.js";

// Valid Linear CLI commands that wake-up messages may reference.
// Any backtick-wrapped `linear <cmd>` not in this list is a test failure.
const VALID_WAKE_UP_COMMANDS = [
  "linear consider-work",
  "linear queue --next",
  "linear queue",
];

function findInvalidLinearCommand(message: string): string | null {
  const pattern = /`(linear [^`]+)`/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(message)) !== null) {
    const cmd = match[1];
    if (!VALID_WAKE_UP_COMMANDS.some((v) => cmd === v || cmd.startsWith(v + " "))) {
      return cmd;
    }
  }
  return null;
}

describe("buildWakeUpMessage — single ticket", () => {
  test("includes linear consider-work with the ticket ID", () => {
    const msg = buildWakeUpMessage(["AI-832"]);
    expect(msg).toContain("linear consider-work AI-832");
  });

  test("does not mention linear my-next", () => {
    const msg = buildWakeUpMessage(["AI-832"]);
    expect(msg).not.toContain("linear my-next");
  });

  test("only references valid Linear CLI commands", () => {
    const msg = buildWakeUpMessage(["AI-832"]);
    expect(findInvalidLinearCommand(msg)).toBeNull();
  });

  test("contains the ticket ID", () => {
    const msg = buildWakeUpMessage(["ILL-500"]);
    expect(msg).toContain("ILL-500");
  });
});

describe("buildWakeUpMessage — multiple tickets", () => {
  test("includes linear queue --next", () => {
    const msg = buildWakeUpMessage(["AI-832", "AI-833"]);
    expect(msg).toContain("linear queue --next");
  });

  test("includes linear queue", () => {
    const msg = buildWakeUpMessage(["AI-832", "AI-833"]);
    expect(msg).toContain("linear queue");
  });

  test("does not mention linear my-next", () => {
    const msg = buildWakeUpMessage(["AI-832", "AI-833", "AI-834"]);
    expect(msg).not.toContain("linear my-next");
  });

  test("only references valid Linear CLI commands", () => {
    const msg = buildWakeUpMessage(["AI-832", "AI-833"]);
    expect(findInvalidLinearCommand(msg)).toBeNull();
  });

  test("lists all ticket IDs", () => {
    const msg = buildWakeUpMessage(["AI-832", "AI-833"]);
    expect(msg).toContain("AI-832");
    expect(msg).toContain("AI-833");
  });
});

describe("buildWakeUpMessage — custom template", () => {
  test("custom template is substituted correctly", () => {
    const msg = buildWakeUpMessage(["AI-832", "AI-833"], "Custom: {count} — {tickets}");
    expect(msg).toBe("Custom: 2 — AI-832, AI-833");
  });

  test("replaces all occurrences of {tickets}", () => {
    const msg = buildWakeUpMessage(["AI-832"], "First: {tickets}. Second: {tickets}.");
    expect(msg).toBe("First: AI-832. Second: AI-832.");
  });
});

describe("default templates — command validity", () => {
  test("SINGLE_TICKET_TEMPLATE does not reference linear my-next", () => {
    expect(SINGLE_TICKET_TEMPLATE).not.toContain("linear my-next");
  });

  test("MULTI_TICKET_TEMPLATE does not reference linear my-next", () => {
    expect(MULTI_TICKET_TEMPLATE).not.toContain("linear my-next");
  });

  test("SINGLE_TICKET_TEMPLATE references linear consider-work", () => {
    expect(SINGLE_TICKET_TEMPLATE).toContain("linear consider-work");
  });

  test("MULTI_TICKET_TEMPLATE references linear queue --next", () => {
    expect(MULTI_TICKET_TEMPLATE).toContain("linear queue --next");
  });
});

describe("findInvalidLinearCommand guard", () => {
  test("flags linear my-next as invalid", () => {
    expect(findInvalidLinearCommand("Run `linear my-next` now.")).toBe("linear my-next");
  });

  test("passes linear consider-work AI-832", () => {
    expect(findInvalidLinearCommand("Run `linear consider-work AI-832` to begin.")).toBeNull();
  });

  test("passes linear queue --next", () => {
    expect(findInvalidLinearCommand("Run `linear queue --next` for highest priority.")).toBeNull();
  });

  test("passes linear queue", () => {
    expect(findInvalidLinearCommand("Run `linear queue` to see all.")).toBeNull();
  });
});
