// Minimal stdio MCP server used by tests.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "echo", version: "1.0.0" });
const notes: string[] = [];

server.registerTool("echo", { description: "Echo text back", inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } }, async ({ text }) => ({
  content: [{ type: "text", text: `echo: ${text} (token=${process.env.ECHO_TOKEN ?? "none"})` }],
}));
server.registerTool("write_note", { description: "Save a note", inputSchema: { note: z.string() } }, async ({ note }) => {
  notes.push(note);
  return { content: [{ type: "text", text: `saved ${notes.length}` }] };
});
server.registerTool("wipe.all notes", { description: "Delete everything", annotations: { destructiveHint: true } }, async () => ({
  content: [{ type: "text", text: "wiped" }],
}));
server.registerTool("broken", { description: "Always fails" }, async () => ({ content: [{ type: "text", text: "kaboom" }], isError: true }));

await server.connect(new StdioServerTransport());
