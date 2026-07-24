import { extractSpecFindings } from "./fanout.js";

describe("INF-488: extractSpecFindings ASCII arrow markers", () => {
  it("extracts findings with -> arrow markers", () => {
    const description = `
## Structured
-> sprint-arm-scope: Define the schema
-> sprint-arm-ux: Design the interface
-> sprint-arm-design: Create assets
-> sprint-arm-spike: Research feasibility
`;
    const findings = extractSpecFindings(description, "structured");

    expect(findings).toHaveLength(4);
    expect(findings[0].title).toBe("Define the schema");
    expect(findings[0].child_workflow).toBe("wf:sprint-arm-scope");
    expect(findings[1].title).toBe("Design the interface");
    expect(findings[1].child_workflow).toBe("wf:sprint-arm-ux");
    expect(findings[2].title).toBe("Create assets");
    expect(findings[2].child_workflow).toBe("wf:sprint-arm-design");
    expect(findings[3].title).toBe("Research feasibility");
    expect(findings[3].child_workflow).toBe("wf:sprint-arm-spike");
  });

  it("extracts findings with -> arrow markers and delegate", () => {
    const description = `
## Structured
-> sprint-arm-scope -> igor: Define the schema
-> sprint-arm-ux -> signe: Design the interface
`;
    const findings = extractSpecFindings(description, "structured");

    expect(findings).toHaveLength(2);
    expect(findings[0].title).toBe("Define the schema");
    expect(findings[0].child_workflow).toBe("wf:sprint-arm-scope");
    expect(findings[0].delegate).toBe("igor");
    expect(findings[1].title).toBe("Design the interface");
    expect(findings[1].child_workflow).toBe("wf:sprint-arm-ux");
    expect(findings[1].delegate).toBe("signe");
  });

  it("extracts findings with mixed markers (arrow and bullet/bold)", () => {
    const description = `
## Structured
- **[wf:sprint-arm-scope]**: Define the schema
-> sprint-arm-ux: Design the interface
`;
    const findings = extractSpecFindings(description, "structured");

    expect(findings).toHaveLength(2);
    expect(findings[0].title).toBe("[wf:sprint-arm-scope]");
    expect(findings[0].child_workflow).toBe("wf:sprint-arm-scope");
    expect(findings[1].title).toBe("Design the interface");
    expect(findings[1].child_workflow).toBe("wf:sprint-arm-ux");
  });

  it("preserves LIF-196 style structured specs", () => {
    // LIF-196 style: "-> sprint-arm-scope: ..." or similar
    const description = `
## Structured
-> sprint-arm-scope: Step 1
-> sprint-arm-ux: Step 2
`;
    const findings = extractSpecFindings(description, "structured");
    expect(findings).toHaveLength(2);
    expect(findings[0].child_workflow).toBe("wf:sprint-arm-scope");
    expect(findings[1].child_workflow).toBe("wf:sprint-arm-ux");
  });

  it("preserves INF-479 style structured specs", () => {
    // INF-479 style mentioned ASCII markers
    const description = `
## Structured
-> sprint-arm-spike -> igor: Spike task
`;
    const findings = extractSpecFindings(description, "structured");
    expect(findings).toHaveLength(1);
    expect(findings[0].child_workflow).toBe("wf:sprint-arm-spike");
    expect(findings[0].delegate).toBe("igor");
  });
});
