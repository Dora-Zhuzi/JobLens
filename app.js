/* 求职小工具 MVP —— 纯前端，数据存 localStorage */
(() => {
  "use strict";

  const STORE_KEY = "joblens.jobs.v1";

  /* ---------- 模板：固定板块标题 + 默认填充内容 ---------- */
  const SECTIONS = [
    { key: "name",          label: "岗位名称", type: "input",
      placeholder: "岗位名称-公司", def: "" },
    { key: "detail",        label: "岗位详情", type: "textarea", rows: 6,
      placeholder: "图片 OCR 提取的原文…", def: "" },
    { key: "requirements",  label: "岗位要求拆解", type: "req" },
    { key: "match",         label: "个人匹配度分析", type: "match" },
    { key: "interviewHave", label: "已有面试内容", type: "textarea", rows: 3,
      def: "xx公司xx项目内容可作为业务经验案例\nxx经历可作为xx核心能力例证" },
    { key: "interviewNeed", label: "面试需补足内容", type: "textarea", rows: 2,
      def: "花费一周时间掌握技能3" },
    { key: "prepDays",      label: "面试准备时间", type: "days", def: 7 },
  ];

  // 统计排行榜：相邻项循环使用的颜色（描边 + 半透明填充）
  const RANK_COLORS = ["#3b6ef5", "#1ca672", "#e2873d", "#9b5de5", "#e2483d", "#1fa3c4", "#d4a017", "#e056a0"];
  function hexToRgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }

  // 岗位要求拆解的 4 个固定维度（用于结构化输入与统计）
  const REQ_DIMS = [
    { key: "skill",      label: "技能",         def: "技能1，技能2，技能3" },
    { key: "business",   label: "业务经验",     def: "业务经验1，业务经验2" },
    { key: "core",       label: "核心能力",     def: "能力1，能力2" },
    { key: "idealTrait", label: "理想性格特质", def: "特质1，特质2" },
  ];

  // 个人匹配度分析的 5 个固定维度（各占 20% 权重）
  const MATCH_DIMS = [
    { key: "skill",    label: "技能",     def: "技能1熟练，技能2了解，技能3无" },
    { key: "business", label: "业务经验", def: "业务经验1丰富，业务经验2无" },
    { key: "core",     label: "核心能力", def: "能力1强，能力2弱" },
    { key: "trait",    label: "性格特质", def: "特质1匹配，特质2不匹配" },
    { key: "interest", label: "兴趣度",   def: "高" },
  ];

  /* ---------- 状态 ---------- */
  let jobs = loadLocal();   // 先用浏览器缓存即时渲染，启动后再对接后端文件
  let currentId = null;
  let hasBackend = false;   // 后端（node server.js）是否在运行
  let structReady = false;  // 后端是否配置了 DeepSeek（结构化功能）

  function loadLocal() {
    try { return (JSON.parse(localStorage.getItem(STORE_KEY)) || []).map(migrateJob); }
    catch { return []; }
  }

  // 保存：始终写本地缓存（兜底/离线），有后端时再防抖写入 data/jobs.json
  let saveTimer = null;
  function persist() {
    localStorage.setItem(STORE_KEY, JSON.stringify(jobs));
    if (!hasBackend) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        const r = await fetch("/api/jobs", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(jobs),
        });
        if (!r.ok) throw new Error("HTTP " + r.status);
      } catch (e) {
        console.warn("写入后端文件失败：", e);
        toast("⚠ 保存到文件失败，已存浏览器缓存");
      }
    }, 300);
  }
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  function newJob(partial = {}) {
    const job = { id: uid(), createdAt: Date.now() };
    SECTIONS.forEach(s => {
      if (s.type === "match") {
        job.match = {};
        MATCH_DIMS.forEach(d => { job.match[d.key] = ""; });   // 空值，示例作占位提示
      } else if (s.type === "req") {
        job.requirements = {};
        REQ_DIMS.forEach(d => { job.requirements[d.key] = ""; });
      } else {
        job[s.key] = s.def;
      }
    });
    job.score = null;       // { skill,business,core,trait,interest,total }
    job.scoreHash = "";     // 打分时所用匹配度文本的快照，用于过期检测
    return Object.assign(job, partial);
  }

  // 兼容旧数据：把旧的 match 文本块/prepTime 文本迁移成新结构
  function migrateJob(job) {
    if (!job || typeof job !== "object") return job;
    // match → 对象
    if (typeof job.match !== "object" || job.match === null) {
      const parsed = parseMatchBlob(typeof job.match === "string" ? job.match : "");
      job.match = parsed;
    }
    MATCH_DIMS.forEach(d => { if (job.match[d.key] === undefined) job.match[d.key] = ""; });
    // requirements → 对象
    if (typeof job.requirements !== "object" || job.requirements === null) {
      job.requirements = parseDimBlob(typeof job.requirements === "string" ? job.requirements : "", REQ_DIMS);
    }
    REQ_DIMS.forEach(d => { if (job.requirements[d.key] === undefined) job.requirements[d.key] = ""; });
    // prepTime 文本 → prepDays 数字
    if (job.prepDays === undefined) job.prepDays = parsePrepDays(job.prepTime);
    delete job.prepTime;
    if (job.score === undefined) job.score = null;
    if (job.scoreHash === undefined) job.scoreHash = "";
    return job;
  }

  // 通用：把「维度：内容」多行文本解析成 {key: value} 对象
  function parseDimBlob(text, DIMS) {
    const out = {};
    DIMS.forEach(d => { out[d.key] = ""; });
    String(text || "").split(/\n+/).forEach(line => {
      const idx = line.search(/[:：]/);
      if (idx < 0) return;
      const label = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim();
      const dim = DIMS.find(d => d.label === label) || DIMS.find(d => label.includes(d.label));
      if (dim) out[dim.key] = val;
    });
    return out;
  }
  const parseMatchBlob = text => parseDimBlob(text, MATCH_DIMS);

  function parsePrepDays(t) {
    if (t == null || t === "") return null;
    if (typeof t === "number") return t;
    const s = String(t);
    const wk = s.match(/(\d+(?:\.\d+)?)\s*周/);
    if (wk) return Math.round(parseFloat(wk[1]) * 7);
    const d = s.match(/(\d+(?:\.\d+)?)/);
    return d ? Math.round(parseFloat(d[1])) : null;
  }

  // 匹配度文本快照（用于判断是否需要重新打分）
  function matchHash(match) {
    const s = MATCH_DIMS.map(d => (match[d.key] || "").trim()).join("|");
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return String(h);
  }

  /* ---------- DOM ---------- */
  const $ = sel => document.querySelector(sel);
  const jobListEl   = $("#jobList");
  const jobCountEl  = $("#jobCount");
  const listHintEl  = $("#listEmptyHint");
  const editorEl    = $("#editor");
  const editorEmpty = $("#editorEmpty");
  const saveBtn     = $("#saveBtn");
  const deleteBtn   = $("#deleteBtn");
  // 视图切换 / 分析页
  const mainLayout    = document.querySelector("main.layout");
  const analysisView  = $("#analysisView");
  const tabEditor     = $("#tabEditor");
  const tabAnalysis   = $("#tabAnalysis");
  const analysisBody  = $("#analysisBody");
  const analysisEmpty = $("#analysisEmpty");
  const pageSizeSelect = $("#pageSizeSelect");
  const batchScoreBtn = $("#batchScoreBtn");
  const analyzeBtn    = $("#analyzeBtn");
  const pagerPrev     = $("#pagerPrev");
  const pagerNext     = $("#pagerNext");
  const pagerInfo     = $("#pagerInfo");
  const statsModal    = $("#statsModal");
  const statsMeta     = $("#statsMeta");
  const statsGrid     = $("#statsGrid");

  /* ---------- 渲染左侧列表 ---------- */
  function renderList() {
    jobListEl.innerHTML = "";
    jobCountEl.textContent = jobs.length;
    listHintEl.hidden = jobs.length > 0;
    // 按创建时间倒序展示（最新在最上），不改动底层数组
    const ordered = [...jobs].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    ordered.forEach(job => {
      const li = document.createElement("li");
      li.className = "job-item" + (job.id === currentId ? " active" : "");
      li.textContent = job.name || "未命名岗位";
      li.title = job.name || "未命名岗位";
      li.onclick = () => selectJob(job.id);
      jobListEl.appendChild(li);
    });
  }

  /* ---------- 渲染中间编辑区 ---------- */
  function selectJob(id) {
    currentId = id;
    renderList();
    renderEditor();
  }

  function renderEditor() {
    const job = jobs.find(j => j.id === currentId);
    if (!job) {
      editorEl.hidden = true;
      editorEmpty.hidden = false;
      saveBtn.disabled = deleteBtn.disabled = true;
      return;
    }
    editorEmpty.hidden = true;
    editorEl.hidden = false;
    saveBtn.disabled = deleteBtn.disabled = false;

    editorEl.innerHTML = "";
    let detailField = null;   // 供「自动拆解」取用岗位详情作为输入
    SECTIONS.forEach(s => {
      // 【岗位详情】：带「结构化」按钮
      if (s.key === "detail") {
        const { wrap, field, btn, cmp } = buildAISection(s, job, "🪄 结构化");
        detailField = field;
        wireAI(btn, field, cmp, {
          getInput: () => field.value,
          task: "structure",
          busyText: "结构化中…",
          leftLabel: "原文（可编辑）",
          rightLabel: "结构化结果（可编辑）",
          emptyMsg: "岗位详情为空，无需结构化",
          failMsg: "结构化失败",
        });
        editorEl.appendChild(wrap);
        return;
      }
      // 【岗位要求拆解】：4 个固定维度 + 自动拆解（输入为岗位详情）
      if (s.type === "req") {
        editorEl.appendChild(buildReqSection(s, job, () => (detailField ? detailField.value : "")));
        return;
      }

      // 【个人匹配度分析】：5 个固定维度 + 评估匹配度
      if (s.type === "match") {
        editorEl.appendChild(buildMatchSection(s, job));
        return;
      }
      // 【面试准备时间】：数字 + 固定单位“天”
      if (s.type === "days") {
        editorEl.appendChild(buildDaysSection(s, job));
        return;
      }

      const wrap = document.createElement("div");
      wrap.className = "section";
      const title = document.createElement("div");
      title.className = "section-title";
      title.textContent = s.label;
      wrap.appendChild(title);

      let field;
      if (s.type === "input") {
        field = document.createElement("input");
        field.type = "text";
        if (s.placeholder) field.placeholder = s.placeholder;
      } else {
        field = document.createElement("textarea");
        field.rows = s.rows || 4;
      }
      field.value = job[s.key] || "";
      field.dataset.key = s.key;
      wrap.appendChild(field);
      editorEl.appendChild(wrap);
    });
  }

  // 枚举输入框：灰色占位提示（聚焦即消失，留空失焦再出现）
  function setupEnumInput(inp, placeholder) {
    inp.placeholder = placeholder || "";
    inp.addEventListener("focus", () => { inp.placeholder = ""; });
    inp.addEventListener("blur", () => { inp.placeholder = placeholder || ""; });
  }

  // 个人匹配度分析板块：5 维输入 + 评估按钮 + 分数展示
  function buildMatchSection(s, job) {
    const wrap = document.createElement("div");
    wrap.className = "section";
    const title = document.createElement("div");
    title.className = "section-title with-action";
    const span = document.createElement("span");
    span.textContent = s.label + "（5 维各占 20%）";
    title.appendChild(span);
    const btn = document.createElement("button");
    btn.className = "btn ghost mini struct-btn";
    btn.textContent = "🎯 评估匹配度";
    if (!structReady) { btn.disabled = true; btn.title = "需在 config.json 配置 DeepSeek key 并启动后端"; }
    title.appendChild(btn);
    wrap.appendChild(title);

    MATCH_DIMS.forEach(d => {
      const row = document.createElement("div");
      row.className = "match-row";
      const lab = document.createElement("label");
      lab.textContent = d.label;
      const inp = document.createElement("input");
      inp.type = "text";
      inp.value = (job.match && job.match[d.key]) || "";
      inp.dataset.matchDim = d.key;
      setupEnumInput(inp, d.def);
      row.appendChild(lab);
      row.appendChild(inp);
      wrap.appendChild(row);
    });

    const scoreBox = document.createElement("div");
    scoreBox.className = "score-box";
    wrap.appendChild(scoreBox);
    renderScoreBox(scoreBox, job);

    btn.onclick = () => scoreCurrentJob(btn, scoreBox);
    return wrap;
  }

  // 岗位要求拆解板块：4 维结构化输入 + 自动拆解
  function buildReqSection(s, job, getDetail) {
    const wrap = document.createElement("div");
    wrap.className = "section";
    const title = document.createElement("div");
    title.className = "section-title with-action";
    const span = document.createElement("span");
    span.textContent = s.label + "（逗号分隔多个）";
    title.appendChild(span);
    const btn = document.createElement("button");
    btn.className = "btn ghost mini struct-btn";
    btn.textContent = "🪄 自动拆解";
    if (!structReady) { btn.disabled = true; btn.title = "需在 config.json 配置 DeepSeek key 并启动后端"; }
    title.appendChild(btn);
    wrap.appendChild(title);

    REQ_DIMS.forEach(d => {
      const row = document.createElement("div");
      row.className = "match-row";
      const lab = document.createElement("label");
      lab.textContent = d.label;
      const inp = document.createElement("input");
      inp.type = "text";
      inp.value = (job.requirements && job.requirements[d.key]) || "";
      inp.dataset.reqDim = d.key;
      setupEnumInput(inp, d.def);
      row.appendChild(lab);
      row.appendChild(inp);
      wrap.appendChild(row);
    });

    btn.onclick = async () => {
      const input = getDetail();
      if (!input || !input.trim()) { toast("岗位详情为空，无法自动拆解"); return; }
      collectFields();
      const cur = jobs.find(j => j.id === currentId);
      const hasContent = REQ_DIMS.some(d => (cur.requirements[d.key] || "").trim());
      if (hasContent && !confirm("将用 AI 拆解结果覆盖当前 4 个维度，是否继续？")) return;
      const label = btn.textContent;
      btn.disabled = true; btn.textContent = "拆解中…";
      try {
        const r = await fetch("/api/structure", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: input, task: "requirements" }),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || "自动拆解失败");
        cur.requirements = parseDimBlob(data.text || "", REQ_DIMS);
        persist();
        renderEditor();   // 重新渲染以回填 4 个字段
        toast("已自动拆解");
      } catch (e) {
        toast("自动拆解失败：" + e.message);
        btn.disabled = false; btn.textContent = label;
      }
    };
    return wrap;
  }

  // 面试准备时间：数字 + “天”
  function buildDaysSection(s, job) {
    const wrap = document.createElement("div");
    wrap.className = "section";
    const title = document.createElement("div");
    title.className = "section-title";
    title.textContent = s.label;
    wrap.appendChild(title);
    const row = document.createElement("div");
    row.className = "days-row";
    const inp = document.createElement("input");
    inp.type = "number"; inp.min = "0"; inp.step = "1";
    inp.placeholder = "请输入天数";
    inp.value = (job.prepDays == null ? "" : job.prepDays);
    inp.dataset.days = "1";
    const unit = document.createElement("span");
    unit.className = "days-unit";
    unit.textContent = "天";
    row.appendChild(inp);
    row.appendChild(unit);
    wrap.appendChild(row);
    return wrap;
  }

  // 把编辑区所有字段同步回当前 job 对象
  function collectFields() {
    const job = jobs.find(j => j.id === currentId);
    if (!job) return;
    editorEl.querySelectorAll("[data-key]").forEach(f => { job[f.dataset.key] = f.value; });
    if (!job.match) job.match = {};
    editorEl.querySelectorAll("[data-match-dim]").forEach(f => { job.match[f.dataset.matchDim] = f.value; });
    if (!job.requirements || typeof job.requirements !== "object") job.requirements = {};
    editorEl.querySelectorAll("[data-req-dim]").forEach(f => { job.requirements[f.dataset.reqDim] = f.value; });
    const daysEl = editorEl.querySelector("[data-days]");
    if (daysEl) {
      const v = daysEl.value.trim();
      job.prepDays = v === "" ? null : Math.max(0, Math.round(Number(v) || 0));
    }
  }

  // 构造带 AI 按钮的板块：标题+按钮、主输入框、对比容器
  function buildAISection(s, job, btnText) {
    const wrap = document.createElement("div");
    wrap.className = "section";
    const title = document.createElement("div");
    title.className = "section-title with-action";
    const span = document.createElement("span");
    span.textContent = s.label;
    title.appendChild(span);
    const btn = document.createElement("button");
    btn.className = "btn ghost mini struct-btn";
    btn.textContent = btnText;
    if (!structReady) { btn.disabled = true; btn.title = "需在 config.json 配置 DeepSeek key 并启动后端"; }
    title.appendChild(btn);
    wrap.appendChild(title);

    const field = document.createElement("textarea");
    field.rows = s.rows || 4;
    field.value = job[s.key] || "";
    field.dataset.key = s.key;
    wrap.appendChild(field);

    const cmp = document.createElement("div");
    cmp.className = "detail-compare";
    cmp.hidden = true;
    wrap.appendChild(cmp);
    return { wrap, field, btn, cmp };
  }

  function saveCurrent() {
    if (!jobs.find(j => j.id === currentId)) return;
    collectFields();
    persist();
    renderList();
    toast("已保存");
  }

  /* ---------- 通用 AI：结构化 / 自动拆解 ---------- */
  function wireAI(btn, field, cmp, o) {
    btn.onclick = async () => {
      const input = o.getInput();
      if (!input || !input.trim()) { toast(o.emptyMsg); return; }
      const label = btn.textContent;
      btn.disabled = true; btn.textContent = o.busyText;
      try {
        const r = await fetch("/api/structure", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: input, task: o.task }),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || o.failMsg);
        openCompare(btn, field, cmp, o.leftLabel, o.rightLabel, (data.text || "").trim());
      } catch (e) {
        toast(o.failMsg + "：" + e.message);
      } finally {
        btn.disabled = false; btn.textContent = label;
      }
    };
  }

  // 并列对比：左=当前内容（可编辑），右=AI 结果（可编辑）
  function openCompare(btn, field, cmp, leftLabel, rightLabel, rightValue) {
    const leftValue = field.value;
    field.hidden = true;
    btn.hidden = true;
    cmp.hidden = false;
    cmp.innerHTML =
      '<div class="dc-toolbar">' +
        '<div class="dc-views">' +
          '<button data-view="both" class="active">并列</button>' +
          '<button data-view="orig">左侧</button>' +
          '<button data-view="struct">右侧</button>' +
        '</div>' +
        '<div class="dc-actions">' +
          '<button class="btn success mini dc-replace">✓ 用右侧替换</button>' +
          '<button class="btn ghost mini dc-discard">✕ 放弃</button>' +
        '</div>' +
      '</div>' +
      '<div class="dc-panes" data-view="both">' +
        '<div class="dc-pane dc-orig"><div class="dc-label"></div><textarea></textarea></div>' +
        '<div class="dc-pane dc-struct"><div class="dc-label"></div><textarea></textarea></div>' +
      '</div>';
    cmp.querySelector(".dc-orig .dc-label").textContent = leftLabel;
    cmp.querySelector(".dc-struct .dc-label").textContent = rightLabel;
    const leftTa = cmp.querySelector(".dc-orig textarea");
    const rightTa = cmp.querySelector(".dc-struct textarea");
    leftTa.value = leftValue;
    rightTa.value = rightValue;

    const panes = cmp.querySelector(".dc-panes");
    cmp.querySelectorAll(".dc-views button").forEach(b => {
      b.onclick = () => {
        cmp.querySelectorAll(".dc-views button").forEach(x => x.classList.remove("active"));
        b.classList.add("active");
        panes.dataset.view = b.dataset.view;
      };
    });
    // 用右侧（AI 结果）替换
    cmp.querySelector(".dc-replace").onclick = () => {
      field.value = rightTa.value;
      collectFields(); persist(); renderList();
      closeCompare(btn, field, cmp);
      toast("已替换并保存");
    };
    // 放弃 AI 结果：保留左侧（你可能已编辑过的自有内容）
    cmp.querySelector(".dc-discard").onclick = () => {
      field.value = leftTa.value;
      collectFields(); persist();
      closeCompare(btn, field, cmp);
    };
  }

  function closeCompare(btn, field, cmp) {
    cmp.hidden = true;
    cmp.innerHTML = "";
    field.hidden = false;
    btn.hidden = false;
  }

  /* ---------- 匹配度打分 ---------- */
  // 调后端打分，返回 {skill,business,core,trait,interest,total}
  async function fetchScore(match) {
    const r = await fetch("/api/score", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dims: match || {} }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "打分失败");
    const sc = data.scores || {};
    const total = Math.round(MATCH_DIMS.reduce((sum, d) => sum + (sc[d.key] || 0), 0) / MATCH_DIMS.length);
    return { ...sc, total };
  }

  function isStale(job) {
    return !!(job.score && job.scoreHash && job.scoreHash !== matchHash(job.match || {}));
  }

  function renderScoreBox(box, job) {
    box.innerHTML = "";
    if (!job.score) { box.innerHTML = '<span class="score-empty">尚未评估匹配度</span>'; return; }
    const head = document.createElement("div");
    head.className = "score-head";
    head.innerHTML = `<span class="score-total">匹配度 ${job.score.total}%</span>` +
      (isStale(job) ? '<span class="score-stale">内容已修改，分数可能过期</span>' : "");
    box.appendChild(head);
    const chips = document.createElement("div");
    chips.className = "score-chips";
    MATCH_DIMS.forEach(d => {
      const c = document.createElement("span");
      c.className = "score-chip";
      c.textContent = `${d.label} ${job.score[d.key] != null ? job.score[d.key] : "—"}`;
      chips.appendChild(c);
    });
    box.appendChild(chips);
  }

  async function scoreCurrentJob(btn, scoreBox) {
    collectFields();
    const job = jobs.find(j => j.id === currentId);
    if (!job) return;
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = "评估中…";
    try {
      const score = await fetchScore(job.match);
      job.score = score;
      job.scoreHash = matchHash(job.match || {});
      persist();
      renderScoreBox(scoreBox, job);
      toast(`匹配度 ${score.total}%`);
    } catch (e) {
      toast("评估失败：" + e.message);
    } finally {
      btn.disabled = false; btn.textContent = label;
    }
  }

  /* ---------- 岗位列表 / 分析视图 ---------- */
  let analysisOpen = false;
  let pageSize = 10, page = 1;
  let sortKey = "score", sortDir = "desc";   // 当前排序列与方向
  const selectedIds = new Set();             // 列表页勾选的岗位

  // 表格列：key 为 null 表示不可排序；getter 用于排序取值
  const ANALYSIS_COLS = [
    { label: "#",        key: null },
    { label: "岗位名称",  key: null, cls: "th-name" },
    { label: "匹配度",    key: "score",    get: j => (j.score ? j.score.total : null) },
    { label: "技能",      key: "skill",    get: j => (j.score ? j.score.skill : null) },
    { label: "业务经验",  key: "business", get: j => (j.score ? j.score.business : null) },
    { label: "核心能力",  key: "core",     get: j => (j.score ? j.score.core : null) },
    { label: "性格特质",  key: "trait",    get: j => (j.score ? j.score.trait : null) },
    { label: "兴趣度",    key: "interest", get: j => (j.score ? j.score.interest : null) },
    { label: "准备(天)",  key: "days",     get: j => (j.prepDays == null ? null : j.prepDays) },
    { label: "创建时间",  key: "created",  get: j => (j.createdAt || 0) },
  ];

  function showEditorView() {
    analysisOpen = false;
    mainLayout.hidden = false;
    analysisView.hidden = true;
    tabEditor.classList.add("active");
    tabAnalysis.classList.remove("active");
  }
  function showAnalysisView() {
    analysisOpen = true;
    mainLayout.hidden = true;
    analysisView.hidden = false;
    tabAnalysis.classList.add("active");
    tabEditor.classList.remove("active");
    page = 1;
    renderAnalysis();
  }

  function sortedJobs() {
    const arr = [...jobs];
    const col = ANALYSIS_COLS.find(c => c.key === sortKey);
    const get = (col && col.get) || (j => (j.score ? j.score.total : null));
    const asc = sortDir === "asc";
    // 空值始终排末尾
    arr.sort((x, y) => {
      const a = get(x), b = get(y);
      if (a == null && b == null) return 0;
      if (a == null) return 1;
      if (b == null) return -1;
      return asc ? a - b : b - a;
    });
    return arr;
  }

  // 表头：每个可排序列带一对上/下三角，点▲升序、点▼降序，当前生效高亮
  function renderAnalysisHead() {
    const head = $("#analysisHead");
    head.innerHTML = "";
    // 全选列
    const selTh = document.createElement("th");
    selTh.className = "th-sel";
    const selAll = document.createElement("input");
    selAll.type = "checkbox";
    const all = jobs.length > 0 && jobs.every(j => selectedIds.has(j.id));
    selAll.checked = all;
    selAll.title = "全选/取消全选";
    selAll.onchange = () => {
      if (selAll.checked) jobs.forEach(j => selectedIds.add(j.id));
      else selectedIds.clear();
      renderAnalysis();
    };
    selTh.appendChild(selAll);
    head.appendChild(selTh);
    ANALYSIS_COLS.forEach(col => {
      const th = document.createElement("th");
      if (col.cls) th.className = col.cls;
      const lab = document.createElement("span");
      lab.textContent = col.label;
      th.appendChild(lab);
      if (col.key) {
        const ctl = document.createElement("span");
        ctl.className = "sort-ctl";
        const up = document.createElement("button");
        up.className = "sort-arrow up" + (sortKey === col.key && sortDir === "asc" ? " active" : "");
        up.textContent = "▲"; up.title = "升序";
        up.onclick = () => { sortKey = col.key; sortDir = "asc"; page = 1; renderAnalysis(); };
        const down = document.createElement("button");
        down.className = "sort-arrow down" + (sortKey === col.key && sortDir === "desc" ? " active" : "");
        down.textContent = "▼"; down.title = "降序";
        down.onclick = () => { sortKey = col.key; sortDir = "desc"; page = 1; renderAnalysis(); };
        ctl.appendChild(up);
        ctl.appendChild(down);
        th.appendChild(ctl);
      }
      head.appendChild(th);
    });
  }

  function renderAnalysis() {
    renderAnalysisHead();
    const arr = sortedJobs();
    analysisEmpty.hidden = arr.length > 0;
    const totalPages = Math.max(1, Math.ceil(arr.length / pageSize));
    if (page > totalPages) page = totalPages;
    const start = (page - 1) * pageSize;
    const slice = arr.slice(start, start + pageSize);

    analysisBody.innerHTML = "";
    slice.forEach((job, i) => {
      const tr = document.createElement("tr");
      const dim = k => (job.score && job.score[k] != null ? job.score[k] : "—");
      const totalCell = job.score
        ? `<span class="t-score">${job.score.total}%</span>` + (isStale(job) ? '<span class="stale-dot" title="内容已改，分数可能过期">·过期</span>' : "")
        : "—";
      tr.innerHTML =
        `<td class="td-sel"><input type="checkbox"></td>` +
        `<td>${start + i + 1}</td>` +
        `<td class="col-name" title="点击编辑"></td>` +
        `<td>${totalCell}</td>` +
        `<td>${dim("skill")}</td><td>${dim("business")}</td><td>${dim("core")}</td><td>${dim("trait")}</td><td>${dim("interest")}</td>` +
        `<td>${job.prepDays == null ? "—" : job.prepDays}</td>` +
        `<td>${fmtDate(job.createdAt)}</td>`;
      const cb = tr.querySelector(".td-sel input");
      cb.checked = selectedIds.has(job.id);
      cb.onchange = () => {
        if (cb.checked) selectedIds.add(job.id); else selectedIds.delete(job.id);
        updateSelectionUI();
        // 同步表头全选态
        const selAll = $("#analysisHead .th-sel input");
        if (selAll) selAll.checked = jobs.length > 0 && jobs.every(j => selectedIds.has(j.id));
      };
      const nameTd = tr.querySelector(".col-name");
      nameTd.textContent = job.name || "未命名岗位";
      nameTd.onclick = () => { showEditorView(); selectJob(job.id); };
      analysisBody.appendChild(tr);
    });

    pagerInfo.textContent = `第 ${page}/${totalPages} 页 · 共 ${arr.length} 条`;
    pagerPrev.disabled = page <= 1;
    pagerNext.disabled = page >= totalPages;
    updateSelectionUI();
  }

  function updateSelectionUI() {
    const n = selectedIds.size;
    analyzeBtn.disabled = n === 0;
    analyzeBtn.textContent = n ? `分析选中 (${n})` : "分析选中";
  }

  /* ---------- 岗位要求统计 ---------- */
  function splitItems(raw) {
    return String(raw || "").split(/[，,]/).map(s => s.trim()).filter(Boolean);
  }

  function computeReqStats(selJobs) {
    const total = selJobs.length;
    const result = {};
    REQ_DIMS.forEach(d => {
      const counts = new Map();
      selJobs.forEach(job => {
        const items = new Set(splitItems(job.requirements && job.requirements[d.key]));
        items.forEach(it => counts.set(it, (counts.get(it) || 0) + 1));
      });
      result[d.key] = [...counts.entries()]
        .map(([item, count]) => ({ item, count, ratio: count / total }))
        .sort((a, b) => b.ratio - a.ratio);
    });
    return result;
  }

  function openStats() {
    const selJobs = jobs.filter(j => selectedIds.has(j.id));
    if (!selJobs.length) { toast("请先勾选岗位"); return; }
    const stats = computeReqStats(selJobs);
    statsMeta.textContent = `共 ${selJobs.length} 个岗位`;
    statsGrid.innerHTML = "";
    REQ_DIMS.forEach(d => {
      const card = document.createElement("div");
      card.className = "stats-card";
      const h = document.createElement("h4");
      h.textContent = d.label;
      card.appendChild(h);
      const rows = stats[d.key];
      if (!rows.length) {
        const empty = document.createElement("div");
        empty.className = "stats-empty";
        empty.textContent = "（无数据）";
        card.appendChild(empty);
      } else {
        rows.forEach((r, i) => {
          const pct = Math.round(r.ratio * 100);
          const color = RANK_COLORS[i % RANK_COLORS.length];
          const row = document.createElement("div");
          row.className = "rank-row";
          row.style.borderColor = color;
          const fill = document.createElement("div");
          fill.className = "rank-fill";
          fill.style.width = pct + "%";
          fill.style.background = hexToRgba(color, 0.32);
          const label = document.createElement("span");
          label.className = "rank-label";
          label.textContent = r.item;
          const val = document.createElement("span");
          val.className = "rank-pct";
          val.textContent = `${pct}%（${r.count}/${selJobs.length}）`;
          row.appendChild(fill);
          row.appendChild(label);
          row.appendChild(val);
          card.appendChild(row);
        });
      }
      statsGrid.appendChild(card);
    });
    openModal(statsModal);
  }

  async function batchScore() {
    if (!structReady) { toast("未配置 DeepSeek key，无法打分"); return; }
    const targets = jobs.filter(j => !j.score || isStale(j));
    if (!targets.length) { toast("没有需要打分的岗位"); return; }
    batchScoreBtn.disabled = true;
    let done = 0;
    for (const job of targets) {
      batchScoreBtn.textContent = `打分中 ${done + 1}/${targets.length}…`;
      try {
        const score = await fetchScore(job.match);
        job.score = score;
        job.scoreHash = matchHash(job.match || {});
      } catch (e) { console.warn("打分失败：", job.name, e); }
      done++;
      renderAnalysis();
    }
    persist();
    batchScoreBtn.disabled = false;
    batchScoreBtn.textContent = "为未评分/已过期岗位打分";
    toast(`已完成 ${done} 个岗位打分`);
  }

  function fmtDate(ts) {
    if (!ts) return "—";
    const d = new Date(ts), p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function deleteCurrent() {
    if (!currentId) return;
    if (!confirm("确定删除该岗位？")) return;
    jobs = jobs.filter(j => j.id !== currentId);
    currentId = jobs.length ? jobs[0].id : null;
    persist();
    renderList();
    renderEditor();
    toast("已删除");
  }

  /* ---------- OCR ---------- */
  let ocrWorker = null;        // 复用同一个 worker
  let ocrWorkerPromise = null; // 防止重复初始化
  let progressCb = null;       // 当前识别的进度回调（worker 缓存后仍可更新）

  function getWorker() {
    if (ocrWorker) return Promise.resolve(ocrWorker);
    if (ocrWorkerPromise) return ocrWorkerPromise;
    if (typeof Tesseract === "undefined")
      return Promise.reject(new Error("OCR 库未加载（需联网加载 Tesseract.js）"));
    ocrWorkerPromise = Tesseract.createWorker("chi_sim+eng", 1, {
      logger: m => {
        if (m.status === "recognizing text" && progressCb) progressCb(m.progress);
      }
    }).then(w => (ocrWorker = w));
    return ocrWorkerPromise;
  }

  // 启动时探测后端：有 DeepSeek 就用云端，没有就回退本地
  async function probeBackend() {
    try {
      const r = await fetch("/api/health");
      if (r.ok) {
        const j = await r.json();
        hasBackend = true;
        cloudOCR = j.cloud ? true : false;
        structReady = !!j.struct;
        console.log("后端：已连接 ｜ 存储：文件 ｜ OCR：", cloudOCR ? "百度高精度" : "本地 Tesseract", "｜ 结构化：", structReady ? "DeepSeek" : "未配置");
        return;
      }
    } catch { /* 没有后端 */ }
    hasBackend = false;
    cloudOCR = false;
    console.log("后端：未检测到 ｜ 存储：浏览器 localStorage ｜ OCR：本地 Tesseract");
  }

  // 启动后从后端文件加载；首次升级时把浏览器里已有数据迁移到文件
  async function syncWithBackend() {
    let remote = null;
    try {
      const r = await fetch("/api/jobs");
      if (r.ok) remote = await r.json();
    } catch { return; }
    if (!Array.isArray(remote)) return;

    if (remote.length === 0 && jobs.length > 0) {
      // 后端还空、本地有数据 —— 迁移上去
      persist();
      toast("已把浏览器里的 " + jobs.length + " 份岗位迁移到文件");
      return;
    }
    // 以后端文件为准
    jobs = remote.map(migrateJob);
    currentId = jobs.length ? jobs[0].id : null;
    renderList();
    renderEditor();
    if (analysisOpen) renderAnalysis();
  }

  // 仅在确定不用云端时，才预热本地引擎（避免白下载十几 MB 模型）
  function warmupWorker() { if (cloudOCR === false) getWorker().catch(() => {}); }

  // 缩图：截图分辨率往往过高，限制最长边可大幅提速，文字精度几乎无损
  const MAX_EDGE = 1600;
  function downscale(dataURL) {
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
        if (scale === 1) return resolve(dataURL);
        const c = document.createElement("canvas");
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL("image/png"));
      };
      img.onerror = () => resolve(dataURL);
      img.src = dataURL;
    });
  }

  // 云端（DeepSeek）是否可用：null=未知，true=可用，false=没后端/没key，已回退本地
  let cloudOCR = null;

  async function cloudRecognize(dataURL, onProgress) {
    onProgress && onProgress(0.3);
    const small = await downscale(dataURL);
    const r = await fetch("/api/ocr", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: small }),
    });
    if (r.status === 404 || r.status === 405 || r.status === 503) {
      // 没接后端 / 后端没配 key —— 永久回退本地
      cloudOCR = false;
      if (r.status === 503) toast("后端未配置 DeepSeek key，已回退本地识别");
      return null;
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "云端识别失败");
    cloudOCR = true;
    onProgress && onProgress(1);
    return (data.text || "").trim();
  }

  async function localRecognize(dataURL, onProgress) {
    const w = await getWorker();
    progressCb = onProgress || null;
    try {
      const small = await downscale(dataURL);
      const { data } = await w.recognize(small);
      return (data.text || "").trim();
    } finally {
      progressCb = null;
    }
  }

  async function ocrImage(dataURL, onProgress) {
    // 优先云端（高精度），不可用时自动回退本地 Tesseract
    if (cloudOCR !== false) {
      try {
        const text = await cloudRecognize(dataURL, onProgress);
        if (text !== null) return text;        // 成功（含识别为空字符串）
      } catch (e) {
        console.warn("云端 OCR 失败，回退本地：", e);
        toast("云端识别出错，已回退本地：" + e.message);
      }
    }
    try {
      return await localRecognize(dataURL, onProgress);
    } catch (e) {
      console.warn("本地 OCR 失败", e);
      return "";
    }
  }

  // 把虚线区域接成「点击 + 拖放」上传图片
  function wireDropzone(zoneEl, inputEl) {
    zoneEl.addEventListener("click", e => {
      if (e.target === inputEl) return;
      inputEl.click();
    });
    zoneEl.addEventListener("dragover", e => {
      e.preventDefault();
      zoneEl.classList.add("dz-over");
    });
    zoneEl.addEventListener("dragleave", e => {
      if (e.target === zoneEl) zoneEl.classList.remove("dz-over");
    });
    zoneEl.addEventListener("drop", e => {
      e.preventDefault();
      zoneEl.classList.remove("dz-over");
      const dt = new DataTransfer();
      [...e.dataTransfer.files]
        .filter(f => f.type.startsWith("image/"))
        .forEach(f => dt.items.add(f));
      if (!dt.files.length) return;
      inputEl.files = dt.files;
      inputEl.dispatchEvent(new Event("change"));
    });
  }

  const fileToDataURL = file => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });

  /* ====================================================== */
  /*  单个岗位创建                                            */
  /* ====================================================== */
  const createModal   = $("#createModal");
  const createName    = $("#createName");
  const createImages  = $("#createImages");
  const createPreview = $("#createPreview");
  const createStatus  = $("#createStatus");

  let createFiles = [];   // 累加用户多次选择/拖入的图片（最多 10 张）

  $("#createBtn").onclick = () => {
    createFiles = [];
    createName.value = "";
    createImages.value = "";
    createPreview.innerHTML = "";
    createStatus.textContent = "";
    createStatus.className = "status";
    openModal(createModal);
    warmupWorker();
    createName.focus();
  };

  createImages.onchange = async () => {
    createFiles.push(...createImages.files);
    if (createFiles.length > 10) createFiles = createFiles.slice(0, 10);
    createImages.value = "";
    await renderCreatePreview();
  };

  async function renderCreatePreview() {
    createPreview.innerHTML = "";
    for (let i = 0; i < createFiles.length; i++) {
      const url = await fileToDataURL(createFiles[i]);
      const cell = document.createElement("div");
      cell.className = "thumb-cell";
      const img = document.createElement("img");
      img.src = url; img.className = "thumb";
      const del = document.createElement("button");
      del.className = "thumb-del";
      del.textContent = "×";
      del.title = "移除";
      del.onclick = () => { createFiles.splice(i, 1); renderCreatePreview(); };
      cell.appendChild(img);
      cell.appendChild(del);
      createPreview.appendChild(cell);
    }
    createStatus.textContent = createFiles.length ? `已选 ${createFiles.length} 张（最多 10）` : "";
  }

  $("#createConfirm").onclick = async () => {
    const name = createName.value.trim();
    if (!name) { createStatus.textContent = "请先填写岗位名称"; return; }
    const files = createFiles.slice(0, 10);

    createStatus.className = "status busy";
    let texts = [];
    if (files.length) {
      for (let i = 0; i < files.length; i++) {
        createStatus.textContent = `正在识别第 ${i + 1}/${files.length} 张…`;
        const url = await fileToDataURL(files[i]);
        const t = await ocrImage(url, p =>
          createStatus.textContent = `正在识别第 ${i + 1}/${files.length} 张… ${Math.round(p * 100)}%`);
        if (t) texts.push(t);
      }
    }
    const job = newJob({ name, detail: texts.join("\n\n") });
    jobs.push(job);
    persist();
    closeModal(createModal);
    selectJob(job.id);
    toast("岗位已创建");
  };

  /* ====================================================== */
  /*  批量创建 + 整理                                         */
  /* ====================================================== */
  const batchModal    = $("#batchModal");
  const batchStep1    = $("#batchStep1");
  const batchStep2    = $("#batchStep2");
  const batchImages   = $("#batchImages");
  const batchPreview  = $("#batchPreview");
  const batchStatus   = $("#batchStatus");
  const imagePoolEl   = $("#imagePool");
  const jobPoolEl     = $("#jobPool");

  // 整理阶段的临时数据
  let tempImages = [];  // { id, url, text }
  let tempJobs   = [];  // { id, name, imageIds:[] }

  let batchFiles = [];   // 累加用户多次选择/拖入的图片（不替换、不去重）

  $("#batchBtn").onclick = () => {
    batchFiles = [];
    batchImages.value = "";
    batchPreview.innerHTML = "";
    batchStatus.textContent = "";
    batchStep1.hidden = false;
    batchStep2.hidden = true;
    openModal(batchModal);
    warmupWorker();
  };

  // 每次选/拖图都追加到 batchFiles，然后重绘预览
  batchImages.onchange = async () => {
    batchFiles.push(...batchImages.files);
    batchImages.value = "";   // 清空 input，便于再次选择同一文件也能触发 change
    await renderBatchPreview();
  };

  async function renderBatchPreview() {
    batchPreview.innerHTML = "";
    for (let i = 0; i < batchFiles.length; i++) {
      const url = await fileToDataURL(batchFiles[i]);
      const cell = document.createElement("div");
      cell.className = "thumb-cell";
      const img = document.createElement("img");
      img.src = url; img.className = "thumb";
      const del = document.createElement("button");
      del.className = "thumb-del";
      del.textContent = "×";
      del.title = "移除";
      del.onclick = () => { batchFiles.splice(i, 1); renderBatchPreview(); };
      cell.appendChild(img);
      cell.appendChild(del);
      batchPreview.appendChild(cell);
    }
    batchStatus.textContent = batchFiles.length ? `已选 ${batchFiles.length} 张` : "";
  }

  $("#batchConfirm").onclick = async () => {
    const files = batchFiles;
    if (!files.length) { batchStatus.textContent = "请先选择图片"; return; }

    batchStatus.className = "status busy";
    tempImages = [];
    tempJobs = [];
    for (let i = 0; i < files.length; i++) {
      batchStatus.textContent = `正在识别第 ${i + 1}/${files.length} 张…`;
      const url = await fileToDataURL(files[i]);
      const text = await ocrImage(url, p =>
        batchStatus.textContent = `正在识别第 ${i + 1}/${files.length} 张… ${Math.round(p * 100)}%`);
      const imgId = uid();
      tempImages.push({ id: imgId, url, text });
      // 每张图片先各自生成一个「未知岗位」
      tempJobs.push({ id: uid(), name: "未知岗位", imageIds: [imgId] });
    }
    batchStatus.className = "status";
    batchStep1.hidden = true;
    batchStep2.hidden = false;
    renderOrganize();
  };

  function renderOrganize() {
    // 左侧图片池：展示尚未明确归类用的总览（所有图片都可拖）
    imagePoolEl.innerHTML = "";
    tempImages.forEach(im => {
      const card = makeImgCard(im, 76);
      imagePoolEl.appendChild(card);
    });

    // 右侧岗位池
    jobPoolEl.innerHTML = "";
    tempJobs.forEach(tj => jobPoolEl.appendChild(makeJobCard(tj)));
  }

  function makeImgCard(im, size) {
    const card = document.createElement("div");
    card.className = "img-card";
    card.draggable = true;
    card.dataset.imgId = im.id;
    const img = document.createElement("img");
    img.src = im.url;
    card.appendChild(img);

    // 放大预览按钮
    const zoom = document.createElement("button");
    zoom.className = "img-zoom";
    zoom.textContent = "🔍";
    zoom.title = "放大预览";
    zoom.addEventListener("click", e => { e.stopPropagation(); openLightbox(im.url); });
    card.appendChild(zoom);

    card.addEventListener("dragstart", e => {
      e.dataTransfer.setData("text/plain", im.id);
      card.classList.add("dragging");
    });
    card.addEventListener("dragend", () => card.classList.remove("dragging"));
    // 联动高亮：点击图片 -> 高亮所属岗位；双击 -> 放大预览
    card.addEventListener("click", () => highlightByImage(im.id));
    card.addEventListener("dblclick", () => openLightbox(im.url));
    return card;
  }

  // 灯箱：点击放大查看完整图片
  function openLightbox(url) {
    let lb = document.getElementById("lightbox");
    if (!lb) {
      lb = document.createElement("div");
      lb.id = "lightbox";
      lb.className = "lightbox";
      const big = document.createElement("img");
      lb.appendChild(big);
      const close = document.createElement("button");
      close.className = "lightbox-close";
      close.textContent = "×";
      close.title = "关闭";
      lb.appendChild(close);
      lb.addEventListener("click", () => lb.classList.remove("show"));
      document.addEventListener("keydown", e => {
        if (e.key === "Escape") lb.classList.remove("show");
      });
      document.body.appendChild(lb);
    }
    lb.querySelector("img").src = url;
    lb.classList.add("show");
  }

  function makeJobCard(tj) {
    const card = document.createElement("div");
    card.className = "job-card";
    card.dataset.jobId = tj.id;

    const head = document.createElement("div");
    head.className = "job-card-head";
    const input = document.createElement("input");
    input.value = tj.name;
    input.oninput = () => { tj.name = input.value; };
    head.appendChild(input);
    card.appendChild(head);

    const imgsWrap = document.createElement("div");
    imgsWrap.className = "job-card-imgs";
    tj.imageIds.forEach(id => {
      const im = tempImages.find(x => x.id === id);
      if (!im) return;
      const thumb = document.createElement("img");
      thumb.src = im.url;
      thumb.draggable = true;
      thumb.dataset.imgId = id;
      thumb.title = "双击放大预览";
      thumb.addEventListener("dragstart", e => e.dataTransfer.setData("text/plain", id));
      thumb.addEventListener("click", () => highlightByImage(id));
      thumb.addEventListener("dblclick", () => openLightbox(im.url));
      imgsWrap.appendChild(thumb);
    });
    card.appendChild(imgsWrap);

    // 拖放：把图片归到此岗位
    card.addEventListener("dragover", e => { e.preventDefault(); card.classList.add("drop-target"); });
    card.addEventListener("dragleave", () => card.classList.remove("drop-target"));
    card.addEventListener("drop", e => {
      e.preventDefault();
      card.classList.remove("drop-target");
      const imgId = e.dataTransfer.getData("text/plain");
      moveImage(imgId, tj.id);
    });
    // 点击岗位 -> 高亮其图片
    card.addEventListener("click", e => {
      if (e.target.tagName === "INPUT") return;
      highlightByJob(tj.id);
    });
    return card;
  }

  function moveImage(imgId, targetJobId) {
    // 从原岗位移除
    tempJobs.forEach(j => { j.imageIds = j.imageIds.filter(id => id !== imgId); });
    // 加入目标岗位
    const target = tempJobs.find(j => j.id === targetJobId);
    if (target && !target.imageIds.includes(imgId)) target.imageIds.push(imgId);
    renderOrganize();
  }

  function highlightByImage(imgId) {
    clearHl();
    document.querySelectorAll(`[data-img-id="${imgId}"]`).forEach(el => el.classList.add("hl"));
    const owner = tempJobs.find(j => j.imageIds.includes(imgId));
    if (owner) {
      const jc = jobPoolEl.querySelector(`[data-job-id="${owner.id}"]`);
      if (jc) jc.classList.add("hl");
    }
  }
  function highlightByJob(jobId) {
    clearHl();
    const jc = jobPoolEl.querySelector(`[data-job-id="${jobId}"]`);
    if (jc) jc.classList.add("hl");
    const tj = tempJobs.find(j => j.id === jobId);
    if (tj) tj.imageIds.forEach(id =>
      document.querySelectorAll(`[data-img-id="${id}"]`).forEach(el => el.classList.add("hl")));
  }
  function clearHl() {
    document.querySelectorAll(".hl").forEach(el => el.classList.remove("hl"));
  }

  $("#organizeConfirm").onclick = () => {
    // 空岗位自动删除；其余固化为正式 JD（拼接所属图片 OCR 文本）
    const kept = tempJobs.filter(j => j.imageIds.length > 0);
    if (!kept.length) { toast("没有可保存的岗位"); return; }
    let first = null;
    kept.forEach(tj => {
      const detail = tj.imageIds
        .map(id => (tempImages.find(x => x.id === id) || {}).text || "")
        .filter(Boolean).join("\n\n");
      const job = newJob({ name: tj.name || "未知岗位", detail });
      jobs.push(job);
      if (!first) first = job.id;
    });
    persist();
    closeModal(batchModal);
    // 清除临时状态（原始图片不长期存储）
    tempImages = []; tempJobs = [];
    selectJob(first);
    toast(`已创建 ${kept.length} 个岗位`);
  };

  /* ---------- 工具：弹窗 / toast ---------- */
  function openModal(m) { m.hidden = false; }
  function closeModal(m) { m.hidden = true; }
  document.querySelectorAll("[data-close]").forEach(b =>
    b.onclick = () => closeModal(b.closest(".modal")));
  document.querySelectorAll(".modal").forEach(m =>
    m.addEventListener("click", e => { if (e.target === m) closeModal(m); }));

  let toastTimer = null;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.hidden = true, 1800);
  }

  saveBtn.onclick = saveCurrent;
  deleteBtn.onclick = deleteCurrent;

  // 视图切换 + 分析页控件
  tabEditor.onclick = showEditorView;
  tabAnalysis.onclick = showAnalysisView;
  pageSizeSelect.onchange = () => { pageSize = +pageSizeSelect.value; page = 1; renderAnalysis(); };
  pagerPrev.onclick = () => { if (page > 1) { page--; renderAnalysis(); } };
  pagerNext.onclick = () => { page++; renderAnalysis(); };
  batchScoreBtn.onclick = batchScore;
  analyzeBtn.onclick = openStats;

  /* ---------- 启动 ---------- */
  wireDropzone($("#createDrop"), createImages);
  wireDropzone($("#batchDrop"), batchImages);
  // 先用本地缓存即时渲染
  if (jobs.length) currentId = jobs[0].id;
  renderList();
  renderEditor();
  // 再异步对接后端（探测 + 加载/迁移文件数据）
  (async () => {
    await probeBackend();
    if (hasBackend) await syncWithBackend();
  })();
})();
