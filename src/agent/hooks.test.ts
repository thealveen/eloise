import { describe, expect, it } from "vitest";
import { unwrapSupabaseEnvelope, unwrapSupabaseText } from "./hooks.js";

function makeResponse(innerPayload: string, resultKey = "result"): unknown {
  const inner = { [resultKey]: innerPayload };
  return {
    content: [{ type: "text", text: JSON.stringify(inner) }],
    isError: false,
  };
}

describe("unwrapSupabaseText", () => {
  it("unwraps the four-layer Supabase envelope to the inner JSON rows", () => {
    const rows = '[{"id":1,"name":"Acme"},{"id":2,"name":"Widget"}]';
    const wrapped = `<untrusted-data-abcd1234>${rows}</untrusted-data-abcd1234>`;
    const response = makeResponse(wrapped);

    expect(unwrapSupabaseText(response)).toBe(rows);
  });

  it("returns undefined when content is missing", () => {
    expect(unwrapSupabaseText({ isError: false })).toBeUndefined();
  });

  it("returns undefined when content[0].text is not a string", () => {
    expect(
      unwrapSupabaseText({ content: [{ type: "text", text: 42 }] }),
    ).toBeUndefined();
  });

  it("returns undefined when the outer text is not valid JSON", () => {
    expect(
      unwrapSupabaseText({ content: [{ type: "text", text: "not json {" }] }),
    ).toBeUndefined();
  });

  it("returns undefined when the inner object has no `result` key", () => {
    const response = {
      content: [{ type: "text", text: JSON.stringify({ other: "value" }) }],
    };
    expect(unwrapSupabaseText(response)).toBeUndefined();
  });

  it("returns plain text cleanly when there are no untrusted-data tags", () => {
    const response = makeResponse("Query executed successfully");
    expect(unwrapSupabaseText(response)).toBe("Query executed successfully");
  });
});

describe("unwrapSupabaseEnvelope hook", () => {
  const baseInput = {
    hook_event_name: "PostToolUse" as const,
    session_id: "s",
    transcript_path: "/tmp/x",
    cwd: "/tmp",
    permission_mode: "default" as const,
    tool_use_id: "tu_1",
  };

  it("returns updatedMCPToolOutput for a Supabase tool with a valid envelope", async () => {
    const rows = '[{"id":1}]';
    const wrapped = `<untrusted-data-xyz>${rows}</untrusted-data-xyz>`;
    const tool_response = makeResponse(wrapped);

    const out = await unwrapSupabaseEnvelope(
      {
        ...baseInput,
        tool_name: "mcp__supabase__execute_sql",
        tool_input: {},
        tool_response,
      },
      "tu_1",
      { signal: new AbortController().signal },
    );

    expect(out.hookSpecificOutput).toBeDefined();
    const hso = out.hookSpecificOutput as {
      hookEventName: string;
      updatedMCPToolOutput: { content: { type: string; text: string }[] };
    };
    expect(hso.hookEventName).toBe("PostToolUse");
    expect(hso.updatedMCPToolOutput.content[0].text).toBe(rows);
  });

  it("returns {} for non-Supabase tools", async () => {
    const out = await unwrapSupabaseEnvelope(
      {
        ...baseInput,
        tool_name: "Read",
        tool_input: {},
        tool_response: makeResponse("anything"),
      },
      "tu_1",
      { signal: new AbortController().signal },
    );
    expect(out).toEqual({});
  });

  it("returns {} when the Supabase response has a malformed shape", async () => {
    const out = await unwrapSupabaseEnvelope(
      {
        ...baseInput,
        tool_name: "mcp__supabase__execute_sql",
        tool_input: {},
        tool_response: { content: [{ type: "text", text: "not json {" }] },
      },
      "tu_1",
      { signal: new AbortController().signal },
    );
    expect(out).toEqual({});
  });
});
