# BIM / ISO 19650 Document Generator — MCP Server (402 pay-per-call)

让 AI Agent **按次付费**生成符合 ISO 19650 的建筑信息模型文档。基于 [HTTP 402 Payment Required](https://datatracker.ietf.org/doc/html/draft-ietf-payments-protocol) + 支付宝 AI付（Alipay aipay）官方协议实现：Agent 调用工具 → 收到账单 → 用「支付宝 AI付 Skill」付款 → 拿到文档。

## 服务（远程 MCP，无需本地部署）

**Endpoint:** `https://api.starshower83.cn:7443/mcp` （Streamable HTTP, stateless）

| Tool | 价格 | 说明 |
|---|---|---|
| `get_pricing` | 免费 | 查看实时价格表与能力（发现用，不扣费） |
| `generate_bep` | ¥2 / 次 | ISO 19650-1 **BEP** BIM Execution Plan 执行计划 |
| `generate_eir` | ¥3 / 次 | ISO 19650-2 **EIR** Employer's Information Requirements（LOIN 分级、数据标准、命名规则、CDE 要求） |
| `generate_oir` | ¥3 / 次 | ISO 19650-3 **OIR** Operational IR（AIM 移交、COBie 完整度门槛、FM 集成、POE） |

## 接入方式

### 1. 远程 MCP（推荐，零安装）

在支持 Streamable HTTP 的 MCP 客户端中配置：

```json
{
  "mcpServers": {
    "bim-bep-mcp": {
      "url": "https://api.starshower83.cn:7443/mcp"
    }
  }
}
```

### 2. 本地 stdio（npm）

```bash
npx @starshower/bim-bep-mcp
# 或
git clone https://github.com/starshower83/bim-bep-mcp && cd bim-bep-mcp/mcp
npm install --omit=dev && node server.js
```

stdio 模式同样透传到远程付费后端（`BEP_API_BASE` 可覆盖）。

## 支付流程（Agent 视角）

1. Agent 调用 `generate_bep` / `generate_eir` / `generate_oir` → 返回 **402** + Base64URL 编码的支付宝账单（`Payment-Needed`）
2. Agent 用「支付宝 AI付 Skill」(`alipay-aipay`) 解析账单并向用户发起支付
3. 付款成功后拿到 `Payment-Proof`（含 `protocol.payment_proof` / `trade_no` + `method.client_session`）
4. 再次调用同一工具并传入 `payment_proof` → 验证通过，返回文档全文

幂等保证：同一 `trade_no` 只履约一次；账单 30 分钟有效。

## 输入参数（付费工具通用）

| 参数 | 必填 | 说明 |
|---|---|---|
| `project_name` | ✅ | 项目名称 |
| `client` | — | 业主/发起组织 |
| `location` | — | 项目地点 |
| `payment_proof` | — | （付款后传入）Base64URL 编码的 Payment-Proof JSON |

各工具另有专属参数（如 BEP 的 `lod` / `cde`，EIR 的 `classification`，OIR 的 `fm_system`），见 `tools/list` schema。

## 技术栈

- Node.js ≥ 18, [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) (stateless Streamable HTTP + stdio)
- 后端：Python 3.11 纯标准库 HTTP server（402 闭环、RSA2 验签、SQLite 幂等账本）— 私有，不公开

## License

MIT — MCP 层代码开源；付费后端服务闭源。
