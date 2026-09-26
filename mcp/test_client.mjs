// MCP client 端到端测试：spawn server.js → listTools → callTool
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["server.js"],
  cwd: new URL(".", import.meta.url).pathname,
});

const client = new Client({ name: "test-client", version: "1.0.0" });
await client.connect(transport);

// 1) listTools
const { tools } = await client.listTools();
console.log("✅ 工具列表:", tools.map((t) => t.name).join(", "));

// 2) get_pricing（免费，真实调后端）
const pricing = await client.callTool({ name: "get_pricing", arguments: {} });
console.log("\n=== get_pricing 返回 ===\n" + pricing.content[0].text);

// 3) generate_bep（无 proof → 期望 402 账单）
const bep = await client.callTool({ name: "generate_bep", arguments: { project_name: "测试项目" } });
console.log("\n=== generate_bep（无凭证）返回 ===\n" + bep.content[0].text);

await client.close();
console.log("\n✅ MCP 端到端测试完成");
process.exit(0);
