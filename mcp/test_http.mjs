// Streamable HTTP client 端到端测试：连 /mcp → listTools → callTool
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BASE = process.env.MCP_URL || "http://127.0.0.1:8403";
const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`));
const client = new Client({ name: "streamable-test", version: "1.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log("✅ 工具列表:", tools.map((t) => t.name).join(", "));

const pricing = await client.callTool({ name: "get_pricing", arguments: {} });
console.log("\n=== get_pricing ===\n" + pricing.content[0].text);

const bep = await client.callTool({ name: "generate_bep", arguments: { project_name: "Streamable测试项目" } });
console.log("\n=== generate_bep（无凭证，期望402账单）===\n" + bep.content[0].text.slice(0, 350) + "\n...");

await client.close();
console.log("\n✅ Streamable HTTP 端到端测试完成");
process.exit(0);
