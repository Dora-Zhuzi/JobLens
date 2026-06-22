/**
 * 求职小工具 —— 本地后端
 *  1) 托管静态页面（index.html / styles.css / app.js）
 *  2) 提供 /api/ocr，把图片转发给百度智能云「通用文字识别（高精度版）」
 *
 * 运行：
 *   node server.js   （key 写在 config.json 里）
 * 然后浏览器打开 http://localhost:8000
 *
 * 零第三方依赖，需 Node 18+（内置 fetch）。
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

// 读取配置：优先环境变量，其次 config.json。占位文字视为“未填写”。
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8")); }
  catch { return {}; }
}
const CONFIG = loadConfig();
function cfg(name, def) {
  const v = process.env[name] || CONFIG[name];
  if (v === undefined || v === null) return def;
  const s = String(v).trim();
  if (!s || /^在这里填写|^填写|^your[_-]?key|^<.*>$/i.test(s)) return def; // 占位符 = 未填写
  return s;
}
const PORT = cfg("PORT", 8000);
const BAIDU_API_KEY = cfg("BAIDU_API_KEY", "");
const BAIDU_SECRET_KEY = cfg("BAIDU_SECRET_KEY", "");
const CLOUD_READY = !!(BAIDU_API_KEY && BAIDU_SECRET_KEY);
// 高精度版；如需标准版（免费额度更高、精度略低）改成 general_basic
const BAIDU_OCR_URL = "https://aip.baidubce.com/rest/2.0/ocr/v1/accurate_basic";

// DeepSeek（用于「岗位详情结构化」，纯文本任务）
const DEEPSEEK_API_KEY = cfg("DEEPSEEK_API_KEY", "");
const DEEPSEEK_MODEL = cfg("DEEPSEEK_MODEL", "deepseek-v4-flash");
const DEEPSEEK_API_URL = cfg("DEEPSEEK_API_URL", "https://api.deepseek.com/chat/completions");
const STRUCT_READY = !!DEEPSEEK_API_KEY;

// 岗位数据持久化文件
const DATA_FILE = path.join(__dirname, "data", "jobs.json");

const ROOT = __dirname;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

// 百度 access_token 有效期约 30 天，缓存复用，过期前自动刷新
let tokenCache = { token: "", exp: 0 };
async function getBaiduToken() {
  if (tokenCache.token && Date.now() < tokenCache.exp) return tokenCache.token;
  const url = "https://aip.baidubce.com/oauth/2.0/token" +
    `?grant_type=client_credentials&client_id=${encodeURIComponent(BAIDU_API_KEY)}` +
    `&client_secret=${encodeURIComponent(BAIDU_SECRET_KEY)}`;
  const r = await fetch(url, { method: "POST", headers: { Accept: "application/json" } });
  const j = await r.json();
  if (!j.access_token) {
    throw new Error(j.error_description || j.error || "获取百度 access_token 失败（请检查 API Key / Secret Key）");
  }
  tokenCache = { token: j.access_token, exp: Date.now() + (j.expires_in - 600) * 1000 };
  return tokenCache.token;
}

async function handleOCR(req, res) {
  if (!CLOUD_READY) {
    return sendJSON(res, 503, { error: "服务器未配置百度 OCR 的 API Key / Secret Key" });
  }
  let raw = "";
  req.on("data", c => { raw += c; if (raw.length > 25 * 1024 * 1024) req.destroy(); });
  req.on("end", async () => {
    let image;
    try { image = JSON.parse(raw).image; } catch { return sendJSON(res, 400, { error: "请求体不是合法 JSON" }); }
    if (!image || !/^data:image\//.test(image)) {
      return sendJSON(res, 400, { error: "缺少 image（应为 data:image/... 的 base64）" });
    }
    try {
      const token = await getBaiduToken();
      const b64 = image.replace(/^data:image\/\w+;base64,/, "");
      // 百度要求 image 字段为 urlencode 后的纯 base64（不含 data 前缀）
      const body = "image=" + encodeURIComponent(b64);
      const r = await fetch(`${BAIDU_OCR_URL}?access_token=${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      const data = await r.json();
      if (data.error_code) {
        console.error("百度 OCR 返回错误:", data);
        // 18=QPS超限 / 17=日配额超限 等
        return sendJSON(res, 502, { error: `百度 OCR 错误[${data.error_code}]：${data.error_msg || "未知"}` });
      }
      const text = (data.words_result || []).map(w => w.words).join("\n").trim();
      return sendJSON(res, 200, { text });
    } catch (e) {
      console.error("调用百度 OCR 异常:", e);
      return sendJSON(res, 502, { error: "无法连接百度 OCR：" + e.message });
    }
  });
}

const STRUCT_PROMPT =
  "你是文本整理助手。请把下面这段招聘岗位 JD 原文做结构化整理：合理分段、提炼小标题、" +
  "把职责/要求/福利等用条目列出，让层次更清晰。\n\n" +
  "严格要求：只做组织与排版上的整理，不得新增、删除、改写或编造任何信息，" +
  "必须忠实保留原文的全部事实与表述。直接输出整理后的内容，不要任何额外说明或开场白。\n\n原文：\n";

const REQ_PROMPT =
  "请阅读下面的招聘岗位 JD，把岗位要求拆解为四个维度。严格按如下格式输出，每行一个维度，" +
  "维度内的要点用中文逗号「，」分隔，不要输出其他任何内容（不要标题、解释、空行）：\n" +
  "技能：xxx，xxx，xxx\n业务经验：xxx，xxx\n核心能力：xxx，xxx\n理想性格特质：xxx，xxx\n\n" +
  "要求：基于 JD 内容合理提炼归纳，贴合岗位；不要编造与 JD 完全无关的内容；某维度若 JD 无相关信息可少写或留空。\n\nJD 原文：\n";

const PROMPTS = { structure: STRUCT_PROMPT, requirements: REQ_PROMPT };

function handleStructure(req, res) {
  if (!STRUCT_READY) {
    return sendJSON(res, 503, { error: "服务器未配置 DEEPSEEK_API_KEY（AI 功能需要）" });
  }
  let raw = "";
  req.on("data", c => { raw += c; if (raw.length > 5 * 1024 * 1024) req.destroy(); });
  req.on("end", async () => {
    let text, task;
    try { ({ text, task } = JSON.parse(raw)); } catch { return sendJSON(res, 400, { error: "请求体不是合法 JSON" }); }
    if (!text || !text.trim()) return sendJSON(res, 400, { error: "缺少 text（输入内容）" });
    const prompt = PROMPTS[task] || STRUCT_PROMPT;
    try {
      const r = await fetch(DEEPSEEK_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
        body: JSON.stringify({
          model: DEEPSEEK_MODEL,
          temperature: 0,
          messages: [{ role: "user", content: prompt + text }],
        }),
      });
      const data = await r.json();
      if (!r.ok) {
        console.error("DeepSeek 返回错误:", data);
        return sendJSON(res, 502, { error: (data.error && data.error.message) || "DeepSeek 调用失败" });
      }
      const out = (data.choices?.[0]?.message?.content || "").trim();
      if (!out) return sendJSON(res, 502, { error: "模型未返回内容，请重试" });
      return sendJSON(res, 200, { text: out });
    } catch (e) {
      console.error("调用 DeepSeek 异常:", e);
      return sendJSON(res, 502, { error: "无法连接 DeepSeek：" + e.message });
    }
  });
}

const SCORE_PROMPT =
  "你是求职匹配度评估助手。下面是求职者对自己在某个岗位 5 个维度上匹配情况的自我描述。\n" +
  "请仅根据每个维度的描述文字本身，对该维度的匹配程度打一个 0–100 的整数分：\n" +
  "描述越正面/越强（如 熟练、丰富、强、匹配、高）越接近 100；\n" +
  "居中（如 了解、一般、中、部分匹配）给 40–70；\n" +
  "越弱/越负面（如 无、弱、不匹配、低）越接近 0；该维度描述为空则给 0。\n" +
  "严格只输出 JSON，键为 skill/business/core/trait/interest，值为整数，不要任何解释或代码块标记。\n" +
  '示例：{"skill":80,"business":60,"core":70,"trait":50,"interest":90}\n\n描述：\n';

// 从模型输出里稳健地提取 JSON 对象
function extractJSON(s) {
  if (!s) return null;
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

function handleScore(req, res) {
  if (!STRUCT_READY) {
    return sendJSON(res, 503, { error: "服务器未配置 DEEPSEEK_API_KEY（打分功能需要）" });
  }
  let raw = "";
  req.on("data", c => { raw += c; if (raw.length > 2 * 1024 * 1024) req.destroy(); });
  req.on("end", async () => {
    let dims;
    try { dims = JSON.parse(raw).dims; } catch { return sendJSON(res, 400, { error: "请求体不是合法 JSON" }); }
    if (!dims || typeof dims !== "object") return sendJSON(res, 400, { error: "缺少 dims（5 个维度的描述）" });
    const desc =
      `技能：${dims.skill || "（空）"}\n业务经验：${dims.business || "（空）"}\n` +
      `核心能力：${dims.core || "（空）"}\n性格特质：${dims.trait || "（空）"}\n兴趣度：${dims.interest || "（空）"}`;
    try {
      const r = await fetch(DEEPSEEK_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
        body: JSON.stringify({
          model: DEEPSEEK_MODEL,
          temperature: 0,
          messages: [{ role: "user", content: SCORE_PROMPT + desc }],
        }),
      });
      const data = await r.json();
      if (!r.ok) {
        console.error("DeepSeek 返回错误:", data);
        return sendJSON(res, 502, { error: (data.error && data.error.message) || "DeepSeek 调用失败" });
      }
      const out = data.choices?.[0]?.message?.content || "";
      const parsed = extractJSON(out);
      if (!parsed) return sendJSON(res, 502, { error: "模型未返回有效分数，请重试" });
      const clamp = v => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
      const scores = {
        skill: clamp(parsed.skill), business: clamp(parsed.business), core: clamp(parsed.core),
        trait: clamp(parsed.trait), interest: clamp(parsed.interest),
      };
      return sendJSON(res, 200, { scores });
    } catch (e) {
      console.error("调用 DeepSeek 异常:", e);
      return sendJSON(res, 502, { error: "无法连接 DeepSeek：" + e.message });
    }
  });
}

// 读取岗位数据（文件不存在时返回空数组）
function readJobs(res) {
  fs.readFile(DATA_FILE, "utf8", (err, txt) => {
    if (err) return sendJSON(res, 200, []);
    try { sendJSON(res, 200, JSON.parse(txt)); }
    catch { sendJSON(res, 200, []); }
  });
}

// 写入岗位数据（原子写：先写临时文件再 rename，避免写一半损坏）
function writeJobs(req, res) {
  let raw = "";
  req.on("data", c => { raw += c; if (raw.length > 50 * 1024 * 1024) req.destroy(); });
  req.on("end", () => {
    let data;
    try { data = JSON.parse(raw); } catch { return sendJSON(res, 400, { error: "请求体不是合法 JSON" }); }
    if (!Array.isArray(data)) return sendJSON(res, 400, { error: "数据应为数组" });
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      const tmp = DATA_FILE + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, DATA_FILE);
      sendJSON(res, 200, { ok: true, count: data.length });
    } catch (e) {
      console.error("写入数据失败:", e);
      sendJSON(res, 500, { error: "写入数据失败：" + e.message });
    }
  });
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.join(ROOT, path.normalize(urlPath));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end("Forbidden"); }
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404); return res.end("Not Found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/api/health")
    return sendJSON(res, 200, { cloud: CLOUD_READY, struct: STRUCT_READY, model: "baidu-accurate-ocr", storage: "file" });
  if (req.method === "GET" && req.url === "/api/jobs") return readJobs(res);
  if (req.method === "PUT" && req.url === "/api/jobs") return writeJobs(req, res);
  if (req.method === "POST" && req.url === "/api/ocr") return handleOCR(req, res);
  if (req.method === "POST" && req.url === "/api/structure") return handleStructure(req, res);
  if (req.method === "POST" && req.url === "/api/score") return handleScore(req, res);
  if (req.method === "GET") return serveStatic(req, res);
  res.writeHead(405); res.end("Method Not Allowed");
});

server.listen(PORT, () => {
  console.log(`\n  求职小工具已启动： http://localhost:${PORT}`);
  console.log(`  OCR 引擎： ${CLOUD_READY ? "百度高精度 OCR（已配置 key）" : "未配置 key —— 将回退浏览器本地 Tesseract"}`);
  console.log(`  结构化： ${STRUCT_READY ? "DeepSeek " + DEEPSEEK_MODEL + "（已配置 key）" : "未配置 DEEPSEEK_API_KEY —— 结构化按钮不可用"}\n`);
});
