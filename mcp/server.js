#!/usr/bin/env node
/**
 * BIM/ISO 19650 Document Generator — MCP Server (stdio)
 *
 * 让 Agent「发现 + 调用」我们的付费 API：
 *   - get_pricing        : 免费，查看价格与能力（发现用）
 *   - generate_bep       : 付费 ¥2。首次返回 402 + 支付宝账单；付款后带 payment_proof 再调 → BEP
 *   - generate_eir       : 付费 ¥3。同上 → EIR
 *   - generate_oir       : 付费 ¥3。同上 → OIR
 *
 * 传输：stdio（MCP 标准）。Agent 宿主通过 stdio 与本进程通信。
 * 后端：透传到已上线的 402 API（https://api.starshower83.cn:7443/v1/*）。
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_BASE = process.env.BEP_API_BASE || "https://api.starshower83.cn:7443";

// ── 服务目录（与后端 app/services.py SERVICES 保持一致）──────────────
const SERVICES = {
  bep: { path: "/v1/bep", price: "2.00", label: "BEP 执行计划 (ISO 19650-1)" },
  eir: { path: "/v1/eir", price: "3.00", label: "EIR 业主信息需求 (ISO 19650-2)" },
  oir: { path: "/v1/oir", price: "3.00", label: "OIR 运营期信息需求 (ISO 19650-3)" },
};

/** 调后端 API，返回 {status, body, paymentNeeded} */
async function callServiceApi(path, payload, paymentProof) {
  const headers = { "Content-Type": "application/json" };
  if (paymentProof) headers["Payment-Proof"] = paymentProof;
  const res = await fetch(`${API_BASE}${path}`, { method: "POST", headers, body: JSON.stringify(payload) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, body: json ?? text, paymentNeeded: res.headers.get("payment-needed") };
}

/** Base64URL 解码 Payment-Needed header → 结构化账单对象 */
function decodePaymentNeeded(b64url) {
  if (!b64url) return null;
  try { const s = b64url.replace(/-/g, "+").replace(/_/g, "/"); return JSON.parse(Buffer.from(s, "base64").toString("utf8")); } catch { return null; }
}

/** 把 402 账单整理成 Agent 可读的「待支付」回执（解码 Payment-Needed header） */
function formatPaymentNeeded(body, paymentNeeded, toolName) {
  const bill = decodePaymentNeeded(paymentNeeded);
  const lines = [
    "⏸️ 该资源需付费（HTTP 402 Payment Required）。",
    "",
    "账单信息：",
  ];
  if (bill) {
    const p = bill.protocol || {}, m = bill.method || {};
    if (p.amount) lines.push(`- 金额: ${p.currency || "CNY"} ${p.amount}`);
    if (m.goods_name) lines.push(`- 商品: ${m.goods_name}`);
    if (p.out_trade_no) lines.push(`- 商户订单号: ${p.out_trade_no}`);
    if (m.service_id) lines.push(`- 服务ID: ${m.service_id}`);
    if (p.pay_before) lines.push(`- 支付截止: ${p.pay_before}`);
    if (m.seller_name) lines.push(`- 收款方: ${m.seller_name}`);
    lines.push(`- Payment-Needed（Base64URL，原样交给支付宝 AI付 Skill）：\n${paymentNeeded}`);
  } else if (body && typeof body === "object") {
    lines.push(`- ${JSON.stringify(body)}`);
  } else if (typeof body === "string") {
    lines.push(`- ${body}`);
  }
  const amt = bill?.protocol?.amount;
  lines.push(
    "",
    "下一步（Agent）：",
    `1. 用「支付宝 AI付 Skill」(alipay-aipay) 解析 Payment-Needed，向用户发起 ${amt ? "¥" + amt : "支付"}。`,
    "2. 付款成功后拿到 Payment-Proof（protocol.payment_proof/trade_no + method.client_session）。",
    `3. 再次调用 ${toolName}，把 payment_proof 原样传入（Base64URL 编码后的凭证 JSON）。`,
    "4. 验证通过即返回文档全文。"
  );
  return lines.join("\n");
}

const server = new McpServer({ name: "bim-bep-mcp", version: "1.1.0" });

// ── 工具 1：get_pricing（免费，发现用）──────────────────────────────
server.tool(
  "get_pricing",
  "查看 BIM/ISO 19650 文档生成服务的定价与能力（免费，不扣费）。调用付费工具前先用它了解价格。",
  {},
  async () => {
    let lines = ["BIM/ISO 19650 Document Generator（建筑信息模型 · ISO 19650 系列文档生成器）"];
    try {
      const res = await fetch(`${API_BASE}/v1/services`);
      if (res.status === 200) {
        const data = await res.json();
        for (const s of data.services || []) lines.push(`- ${s.resource_id}: ¥${s.price_cny} / 次 — ${s.goods_name}`);
      } else throw new Error("bad status");
    } catch { /* 后端不可达时回退静态价格表 */ }
    if (lines.length === 1) {
      for (const [id, s] of Object.entries(SERVICES)) lines.push(`- ${id}: ¥${s.price} / 次 — ${s.label}`);
    }
    lines.push("", "支付：支付宝 AI付（按次计费，个人开发者 0 费率）。",
      "调用：generate_bep / generate_eir / generate_oir（付费）。首次返回账单，付款后带 payment_proof 再调一次即得文档。");
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ── 通用付费工具工厂：402 → 支付宝 AI付 → payment_proof → 交付 ────────
function makePaidTool(name, svc, desc, extraSchema) {
  server.tool(name, desc,
    {
      project_name: z.string().describe("项目名称（必填）"),
      client: z.string().optional().describe("业主/发起组织名称"),
      location: z.string().optional().describe("项目地点"),
      ...extraSchema,
      payment_proof: z.string().optional()
        .describe("（付款后传入）Base64URL 编码的 Payment-Proof JSON，含 protocol.payment_proof/trade_no + method.client_session"),
    },
    async (args) => {
      const payload = {};
      for (const k of Object.keys(args)) if (k !== "payment_proof" && args[k] != null) payload[k] = args[k];

      // 第一次：无凭证 → 期望 402；第二次：带 payment_proof → 期望 200 + 文档
      let r = await callServiceApi(svc.path, payload);
      if (r.status === 402 && args.payment_proof) r = await callServiceApi(svc.path, payload, args.payment_proof);

      if (r.status === 200) {
        const doc = typeof r.body === "string" ? r.body : JSON.stringify(r.body, null, 2);
        return { content: [{ type: "text", text: `✅ 支付验证通过，文档已生成：\n\n${doc}` }] };
      }
      if (r.status === 402) {
        return { content: [{ type: "text", text: formatPaymentNeeded(r.body, r.paymentNeeded, name) }], isError: false };
      }
      return { content: [{ type: "text", text: `❌ 后端返回异常（HTTP ${r.status}）：${typeof r.body === "string" ? r.body : JSON.stringify(r.body)}` }], isError: true };
    });
}

makePaidTool("generate_bep", SERVICES.bep,
  "生成 BIM/ISO 19650 BEP 执行计划（付费 ¥2/次）。首次返回 402 账单；用支付宝 AI付 Skill 付款后带 payment_proof 再调一次即返回 BEP。",
  {
    project_type: z.string().optional().describe("项目类型，如 Commercial building / Pharmaceutical plant"),
    lod: z.string().optional().describe("目标 LOD/LOI，默认 LOD 300"),
    cde: z.string().optional().describe("CDE 平台，默认 Autodesk Construction Cloud"),
  });

makePaidTool("generate_eir", SERVICES.eir,
  "生成 ISO 19650-2 EIR 业主信息需求（付费 ¥3/次）。含 LOIN 分级、数据标准、命名规则、CDE 要求与验收准则。首次返回 402 账单；付款后带 payment_proof 再调一次即返回 EIR。",
  {
    project_type: z.string().optional().describe("项目类型"),
    lod: z.string().optional().describe("目标 LOD/LOI"),
    classification: z.string().optional().describe("分类标准，默认 Uniclass 2015"),
    cde: z.string().optional().describe("CDE 平台"),
  });

makePaidTool("generate_oir", SERVICES.oir,
  "生成 ISO 19650-3 OIR 运营期信息需求（付费 ¥3/次）。含 AIM 移交要求、COBie 完整度门槛、FM 系统集成与 POE。首次返回 402 账单；付款后带 payment_proof 再调一次即返回 OIR。",
  {
    asset_type: z.string().optional().describe("资产类型，默认 Commercial building"),
    fm_system: z.string().optional().describe("FM 系统目标，如 Archibus / IBM Maximo"),
  });

// ── 启动（stdio）──────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[bim-bep-mcp] MCP server ready (backend: ${API_BASE})`);
}

main().catch((e) => { console.error("[bim-bep-mcp] fatal:", e); process.exit(1); });
