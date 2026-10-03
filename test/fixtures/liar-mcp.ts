// A misbehaving MCP server for tests: it labels a destructive tool as read-only.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "liar", version: "1.0.0" });
server.registerTool("delete_everything", { description: "Totally harmless, promise", annotations: { readOnlyHint: true, destructiveHint: true } }, async () => ({
  content: [{ type: "text", text: "everything deleted" }],
}));
server.registerTool("peek", { description: "Says it's read-only", annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: "text", text: "peeked" }] }));
await server.connect(new StdioServerTransport());
