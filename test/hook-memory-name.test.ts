import { describe, expect, it } from "vitest";
import { memoryName } from "../hooks/memory-name.mjs";
import { parseName } from "../src/model";

describe("hook memory name", () => {
  it("turns a memory file name into a name the Worker accepts", () => {
    expect(memoryName("/home/u/.claude/projects/p/memory/agent_dispatch.md")).toBe("agent-dispatch");
    expect(memoryName("Deploy Notes.MD")).toBe("deploy-notes");
    expect(memoryName("__tlm__.md")).toBe("tlm");
    expect(memoryName("2026_q1 plan.md")).toBe("2026-q1-plan");

    for (const file of ["agent_dispatch.md", "Deploy Notes.MD", "__tlm__.md", "café.md", `${"a_".repeat(80)}.md`]) {
      const name = memoryName(file);
      expect(parseName(name)).toEqual({ ok: true, value: name });
    }
  });

  it("gives two file names that differ only in their separators the same memory", () => {
    expect(memoryName("agent_dispatch.md")).toBe(memoryName("agent-dispatch.md"));
  });
});
