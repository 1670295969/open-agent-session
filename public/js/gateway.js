/* 网关管理界面 */
"use strict";

const gw = {
  data: null,        // /api/gw/state 的返回
  tab: "providers",
  editing: null,     // 正在编辑的 provider id（null = 新增表单未开）
  busy: false,
  range: 0,          // 用量时间范围：0 = 全部，否则近 N 天
};

function gwOpen() {
  document.documentElement.classList.add("gw-open");
  gwLoad();
}

function gwClose() {
  document.documentElement.classList.remove("gw-open");
}

function gwTab(t) {
  gw.tab = t;
  gwRender();
}

async function gwFetch(url, opts) {
  const r = await fetch(url, opts);
  let d = null;
  try { d = await r.json(); } catch { d = null; }
  if (!r.ok) throw new Error((d && d.error) || ("HTTP " + r.status));
  return d;
}

async function gwLoad() {
  try {
    const since = gw.range ? Date.now() - gw.range * 86400000 : 0;
    gw.data = await gwFetch("/api/gw/state?since=" + since);
    gwRender();
  } catch (e) {
    $("#gwbody").innerHTML = `<div class="gwpage on"><div class="gwcard"><div class="gwempty">
      <span class="em">⚠</span>加载失败：${esc(e.message)}</div></div></div>`;
  }
}

// ---- 渲染 ----

function gwRender() {
  const d = gw.data;
  if (!d) return;
  const body = $("#gwbody");
  body.innerHTML = `
    <div class="gwpage ${gw.tab === "providers" ? "on" : ""}" id="gwp-providers"></div>
    <div class="gwpage ${gw.tab === "groups" ? "on" : ""}" id="gwp-groups"></div>
    <div class="gwpage ${gw.tab === "agents" ? "on" : ""}" id="gwp-agents"></div>
    <div class="gwpage ${gw.tab === "usage" ? "on" : ""}" id="gwp-usage"></div>
    <div class="gwpage ${gw.tab === "endpoints" ? "on" : ""}" id="gwp-endpoints"></div>
  `;
  // 顶栏：开关 + 页签状态
  const sw = $("#gwsw");
  sw.classList.toggle("on", !!d.enabled);
  sw.querySelector(".lbl").textContent = d.enabled ? "网关已启用" : "网关已关闭";

  for (const b of document.querySelectorAll("#gwtabs button")) {
    b.classList.toggle("on", b.dataset.t === gw.tab);
  }

  if (gw.tab === "providers") gwRenderProviders();
  else if (gw.tab === "groups") gwRenderGroups();
  else if (gw.tab === "agents") gwRenderAgents();
  else if (gw.tab === "usage") gwRenderUsage();
  else if (gw.tab === "endpoints") gwRenderEndpoints();
}

function gwStatCard(label, value, sub, bad) {
  return `<div class="gwst ${bad ? "bad" : ""}">
    <div class="k">${esc(label)}</div>
    <div class="v">${value}${sub ? `<small>${esc(sub)}</small>` : ""}</div>
  </div>`;
}

// 延迟格式化：按量级选单位。
// 不用统一 toFixed(1)+"s" —— 23ms 会显示成 "0.0s"，看起来像没测到。
function gwMs(ms) {
  ms = Number(ms) || 0;
  if (!ms) return "—";
  if (ms < 1000) return Math.round(ms) + "ms";
  if (ms < 60000) return (ms / 1000).toFixed(1) + "s";
  return Math.round(ms / 60000) + "m";
}

function gwNum(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}

// ---- 供应商页 ----
function gwRenderProviders() {
  const d = gw.data;
  const el = $("#gwp-providers");
  const s = d.stats;

  const cards = `
    <div class="gwstats">
      ${gwStatCard("供应商", d.providers.length, "家")}
      ${gwStatCard("已启用", d.providers.filter((p) => p.enabled).length, "家")}
      ${gwStatCard("模型", d.models.filter((m) => !m.startsWith("group/")).length, "个")}
      ${gwStatCard("调用", gwNum(s.calls), "", false)}
      ${gwStatCard("失败", gwNum(s.errors), s.calls ? "· " + Math.round(s.errors / s.calls * 100) + "%" : "", s.errors > 0)}
      ${gwStatCard("平均延迟", gwMs(s.msAvg), "", false)}
    </div>`;

  const list = d.providers.length ? d.providers.map(gwProviderRow).join("")
    : `<div class="gwempty"><span class="em">🔌</span>还没有供应商。点上方「＋ 添加供应商」加一家，填上基址与密钥就能用。</div>`;

  el.innerHTML = `
    <div class="gwcard">
      <h3>网关状态 <span class="sub">供应商池 · 模型寻址 · 故障转移</span><span class="grow"></span>
        <button onclick="gwToggleDefault()">默认：${esc(d.defaultProvider || "未设置")}</button>
      </h3>
      ${cards}
      <div class="gwnote">
        <b>模型寻址</b>：<code>provider/model</code> 指定某家；<code>group/名字</code> 走路由组；
        只写 <code>model</code> 时用默认供应商，并在其他声明了同名模型的家里故障转移。
        ${d.failover ? "故障转移<b>已开</b>" : "故障转移<b>已关</b>"}
        · 重试 ${d.maxRetries} 次
      </div>
    </div>
    <div class="gwcard">
      <h3>供应商 <span class="sub">一家可同时挂 Chat / Anthropic / Responses 三种基址</span>
        <span class="grow"></span>
        <button class="primary" onclick="gwEditProvider(null)">＋ 添加供应商</button>
      </h3>
      ${list}
    </div>
    ${gw.editing !== null || gw.editing === "new" ? gwProviderForm() : ""}
  `;
}

function gwProviderRow(p) {
  // 标签各自是真实元素，不再靠空格拼串 —— flex 下空白节点会被折叠，gap 也就不生效
  const protos = p.protocols.map((x) =>
    `<span class="proto ${x}">${esc(x === "chat" ? "Chat" : x === "anthropic" ? "Anthropic" : "Responses")}</span>`
  ).join("");

  const bases = [];
  if (p.url) bases.push(`<span>chat <code>${esc(p.url)}</code></span>`);
  if (p.anthropic) bases.push(`<span>anthropic <code>${esc(p.anthropic)}</code></span>`);
  if (p.responses) bases.push(`<span>responses <code>${esc(p.responses)}</code></span>`);

  const keys = p.keys.length
    ? `<div class="gwkeys">${p.keys.map((k, i) => `
        <div class="gwkey">
          <span class="kn">${esc(k.name || "key#" + (i + 1))}</span>
          <code>${esc(k.mask)}</code>
          <button onclick="gwRemoveKey('${escAttr(p.id)}',${i})" title="删除这把密钥">✕</button>
        </div>`).join("")}</div>`
    : "";

  const bal = p.balance
    ? `<span class="pill ${/^-|负/.test(p.balance) ? "bad" : "ok"}">余额 ${esc(p.balance)}</span>`
    : "";

  return `<div class="gwprov ${p.enabled ? "" : "off"}">
    <div class="top">
      <span class="pname"><span class="ptxt">${esc(p.name)}</span><span class="ptags">${protos}</span></span>
      <span class="pid">${esc(p.id)}</span>
      ${p.enabled ? "" : '<span class="pill warn">已停用</span>'}
      ${p.hasKey ? "" : '<span class="pill bad">缺密钥</span>'}
      ${bal}
      <span class="grow"></span>
      <button onclick="gwTestProvider('${escAttr(p.id)}',this)">测连通</button>
      <button onclick="gwEditProvider('${escAttr(p.id)}')">编辑</button>
      <button onclick="gwToggleProvider('${escAttr(p.id)}',${!p.enabled})">${p.enabled ? "停用" : "启用"}</button>
      <button onclick="gwDelProvider('${escAttr(p.id)}','${escAttr(p.name)}')">删除</button>
    </div>
    <div class="meta">${bases.join("") || "<span>（无基址）</span>"}
      ${p.models.length ? `<span>模型 ${p.models.length} 个</span>` : "<span>未填模型</span>"}
      ${p.note ? `<span>${esc(p.note)}</span>` : ""}
    </div>
    ${keys}
  </div>`;
}

function gwProviderForm() {
  const isEdit = gw.editing && gw.editing !== "new";
  const p = isEdit ? gw.data.providers.find((x) => x.id === gw.editing) : null;
  const v = p || { name: "", id: "", url: "", anthropic: "", responses: "", models: [], headers: {}, note: "", balance: "" };

  return `<div class="gwcard" id="gwform">
    <h3>${isEdit ? "编辑供应商" : "添加供应商"} <span class="sub">${isEdit ? escAttr(p.id) : "三家协议基址至少填一个"}</span>
      <span class="grow"></span>
      <button onclick="gwEditProvider(undefined)">取消</button>
    </h3>
    <div class="gwform">
      <div class="row2">
        <div class="gwfield">
          <label>名称 <span class="req">*</span></label>
          <input id="gwname" value="${escAttr(v.name)}" placeholder="例如 moapi" spellcheck="false">
        </div>
        <div class="gwfield">
          <label>ID <span class="opt">（留空自动生成，用作 provider/model 前缀）</span></label>
          <input id="gwid" value="${escAttr(p ? p.id : "")}" placeholder="moapi" spellcheck="false" ${isEdit ? "readonly" : ""}>
        </div>
      </div>
      <div class="gwfield">
        <label>Chat 基址 <span class="opt">（OpenAI /v1/chat/completions，通常带 /v1）</span></label>
        <input id="gwurl" value="${escAttr(v.url)}" placeholder="https://api.example.com/v1" spellcheck="false">
      </div>
      <div class="gwfield">
        <label>Anthropic 基址 <span class="opt">（/v1/messages，带不带 /v1 都行）</span></label>
        <input id="gwanthropic" value="${escAttr(v.anthropic)}" placeholder="https://api.example.com" spellcheck="false">
      </div>
      <div class="gwfield">
        <label>Responses 基址 <span class="opt">（/v1/responses，codex 系）</span></label>
        <input id="gwresponses" value="${escAttr(v.responses)}" placeholder="https://api.example.com/v1" spellcheck="false">
      </div>
      <div class="gwfield">
        <label>模型 <span class="opt">（逗号或空格分隔）</span></label>
        <textarea id="gwmodels" placeholder="gpt-6.2-sol, claude-opus-5-5">${escAttr((v.models || []).join(", "))}</textarea>
        <div class="hint">这些是这家**能提供**的模型名。填了才会出现在模型清单里，也才能被 <code>provider/model</code> 寻址到。</div>
      </div>
      <div class="gwfield">
        <label>密钥 <span class="opt">（${isEdit ? "留空表示不改动" : "可逗号分隔多个，按顺序故障转移"}）</span></label>
        <textarea id="gwkeys" placeholder="sk-..."></textarea>
        <div class="hint">多个 key 用换行或逗号分隔，可写成 <code>名字:sk-xxx</code> 便于区分。密钥单独存 <code>gateway-keys.json</code>（600 权限），不写进主配置。</div>
      </div>
      <div class="gwfield">
        <label>备注</label>
        <input id="gwnote" value="${escAttr(v.note)}" placeholder="例如：中转站，按量计费">
      </div>
      <div class="gwbtns">
        <button onclick="gwEditProvider(undefined)">取消</button>
        <button class="primary" onclick="gwSaveProvider(${isEdit ? `'${escAttr(p.id)}'` : "null"}, this)">
          ${isEdit ? "保存" : "添加"}
        </button>
      </div>
    </div>
  </div>`;
}

// ---- 路由组页 ----
function gwRenderGroups() {
  const d = gw.data;
  const el = $("#gwp-groups");
  const modeOpts = d.routingModes.map((m) =>
    `<option value="${m.id}">${m.id}${m.degraded ? `（等价于 ${m.effective}）` : ""}</option>`
  ).join("");

  const rows = d.groups.length ? d.groups.map((g) => `
    <div class="gwprov">
      <div class="top">
        <span class="pname">group/${esc(g.name)}</span>
        <span class="pill">${esc(g.routing)}${g.effective !== g.routing ? " → " + esc(g.effective) : ""}</span>
        <span class="grow"></span>
        <button onclick="gwEditGroup('${escAttr(g.name)}')">编辑</button>
        <button onclick="gwDelGroup('${escAttr(g.name)}')">删除</button>
      </div>
      <div class="meta">
        ${g.models.map((m) => `<span><code>${esc(m)}</code></span>`).join("") || "<span>（空组）</span>"}
      </div>
    </div>`).join("") : `<div class="gwempty"><span class="em">🧩</span>
      还没有路由组。一个组把几家几个模型当成一个名字给 agent，某一家的额度用完就自动换下一个。</div>`;

  const g = gw.groupEdit && d.groups.find((x) => x.name === gw.groupEdit);

  el.innerHTML = `
    <div class="gwcard">
      <h3>路由组 <span class="sub">把多个 provider/model 合成一个虚拟模型名</span></h3>
      ${rows}
      <div class="gwnote">
        <b>routing 模式</b>：<code>order</code> 用第一个直到失败 →
        <code>rotate</code> 每轮换下一个 → <code>usage</code> 最少用的优先。
        <br><b>smart / pace 是降级的</b>：它们要读各家的配额窗口与重置时刻（magpie 会探测余额），
        本网关不探测余额，所以分别按 order / usage 执行 —— 界面上照实标出来，不假装支持。
      </div>
    </div>
    <div class="gwcard">
      <h3>${g ? "编辑组 " + esc(g.name) : "新建组"}</h3>
      <div class="gwform">
        <div class="row2">
          <div class="gwfield"><label>组名 <span class="req">*</span></label>
            <input id="ggname" value="${escAttr(g ? g.name : "")}" placeholder="daily-coding" ${g ? "readonly" : ""} spellcheck="false"></div>
          <div class="gwfield"><label>routing 模式</label>
            <select id="ggrouting">${modeOpts}</select></div>
        </div>
        <div class="gwfield">
          <label>成员 <span class="req">*</span> <span class="opt">（每行一个 provider/model）</span></label>
          <textarea id="ggmodels" placeholder="moapi/qwen3.8-flash&#10;cctq3/gpt-6.2-sol">${escAttr(g ? g.models.join("\n") : "")}</textarea>
          <div class="hint">可用的模型名：<code>${esc(gw.data.models.join("  ") || "（先加供应商和模型）")}</code></div>
        </div>
        <div class="gwbtns">
          ${g ? `<button onclick="gwEditGroup(null)">取消</button>` : ""}
          <button class="primary" onclick="gwSaveGroup(${g ? `'${escAttr(g.name)}'` : "null"}, this)">${g ? "保存" : "新建"}</button>
        </div>
      </div>
    </div>
  `;
  if (g) $("#ggrouting").value = g.routing;
}

// ---- Agent 指向页 ----
async function gwRenderAgents() {
  const el = $("#gwp-agents");
  el.innerHTML = `<div class="gwcard"><div class="gwempty">读取中…</div></div>`;
  let a;
  try { a = await gwFetch("/api/gw/agents"); }
  catch (e) { el.innerHTML = `<div class="gwcard"><div class="gwempty">读取失败：${esc(e.message)}</div></div>`; return; }

  const modelOpts = gw.data.models.map((m) => `<option value="${escAttr(m)}">`).join("");
  const row = (key, label, cur, supported, extra) => {
    const on = cur.viaGateway;
    return `<div class="gwagent">
      <span class="an">${label}</span>
      <span class="acur">${cur.found
        ? `当前：${on ? '<span class="pill ok">走 OpenSession</span>' : ""}
           ${cur.baseUrl ? `base <code>${esc(cur.baseUrl)}</code>` : ""}
           ${cur.model ? ` · 模型 <code>${esc(cur.model)}</code>` : ""}
           ${cur.modelProvider ? ` · provider <code>${esc(cur.modelProvider)}</code>` : ""}
           ${cur.provider ? ` · provider <code>${esc(cur.provider)}</code>` : ""}`
        : `<span class="muted">未找到配置 <code>${esc(cur.configFile || "")}</code></span>`}
        ${extra || ""}</span>
      <span class="acts">
        ${supported
          ? `<button onclick="gwApplyAgent('${key}',this)">指向网关</button>
             <button onclick="gwRestoreAgent('${key}',this)">还原</button>`
          : `<span class="ro">只读 · ${esc(cur.note || "不支持写入")}</span>`}
      </span>
    </div>`;
  };

  el.innerHTML = `
    <div class="gwcard">
      <h3>Agent 指向 <span class="sub">把 CLI 的 base_url 改到本网关</span></h3>
      <div class="gwfield" style="margin-bottom:12px">
        <label>指向时使用的模型 <span class="opt">（写进 agent 配置的默认模型）</span></label>
        <input id="gwagentmodel" list="gwmodellist" placeholder="provider/model 或 group/名字" spellcheck="false">
        <datalist id="gwmodellist">${modelOpts}</datalist>
      </div>
      ${row("claude", "Claude", a.claude, true)}
      ${row("codex", "Codex", a.codex, true, a.codex.hasBlock ? ' <span class="pill">已注入 opensession 段</span>' : "")}
      ${row("pi", "Pi", a.pi, true)}
      ${row("dsh", "DeepSeek", a.dsh, false)}
      <div class="gwnote warn">
        <b>改动前一律强制备份</b>到 <code>${esc("~/.config/opensession/agent-backups/")}</code>，
        只改自己写的那几个键，其余（modelPicker / statusLine / 其他 provider / 所有注释与段顺序）原样保留。
        「还原」回到你点「指向」之前的原值，不是回到厂商默认 —— 你不知道用户原来是不是走中转站。
        <br><b>dsh 不给开关</b>：它的供应商在 <code>profiles/*/cordis.patch.yml</code> 的四层 YAML 里，
        零依赖下写它要自带一个保留缩进的 YAML 编辑器，代价不成比例。只显示当前指向。
      </div>
    </div>
  `;
}

// ---- 用量页 ----
function gwRenderUsage() {
  const d = gw.data;
  const s = d.stats;
  const max = Math.max(1, ...d.daily.map((x) => x.calls));
  const bars = d.daily.map((x) => {
    const h = Math.max(2, Math.round(x.calls / max * 46));
    return `<div class="b ${x.calls ? "has" : ""} ${x.errors ? "err" : ""}"
      style="height:${h}px" title="${x.date} · ${x.calls} 次${x.errors ? "（" + x.errors + " 失败）" : ""}"></div>`;
  }).join("");

  const provRows = Object.entries(s.byProvider).sort((a, b) => b[1].calls - a[1].calls)
    .map(([k, v]) => `<tr><td><code>${esc(k)}</code></td>
      <td class="num">${v.calls}</td><td class="num">${v.errors || ""}</td>
      <td class="num">${gwNum(v.in)}</td><td class="num">${gwNum(v.out)}</td></tr>`).join("");

  const modelRows = Object.entries(s.byModel).sort((a, b) => b[1].calls - a[1].calls)
    .slice(0, 40)
    .map(([k, v]) => `<tr><td><code>${esc(k)}</code></td>
      <td class="num">${v.calls}</td><td class="num">${v.errors || ""}</td>
      <td class="num">${gwNum(v.in)}</td><td class="num">${gwNum(v.out)}</td></tr>`).join("");

  const ranges = [[0, "全部"], [1, "今天"], [7, "7 天"], [30, "30 天"]];

  $("#gwp-usage").innerHTML = `
    <div class="gwcard">
      <h3>用量
        <span class="grow"></span>
        ${ranges.map(([n, l]) => `<button onclick="gwRange(${n})"
          style="${gw.range === n ? "background:var(--panel2);border-color:var(--border);color:#fff" : ""}">${l}</button>`).join("")}
        <button onclick="gwClearUsage()">清空</button>
      </h3>
      <div class="gwstats">
        ${gwStatCard("调用", gwNum(s.calls), "", false)}
        ${gwStatCard("失败", gwNum(s.errors), "", s.errors > 0)}
        ${gwStatCard("重试后成功", gwNum(s.retried), "", false)}
        ${gwStatCard("输入 token", gwNum(s.in), "", false)}
        ${gwStatCard("输出 token", gwNum(s.out), "", false)}
        ${gwStatCard("缓存读", gwNum(s.cache_read), "", false)}
        ${gwStatCard("首字延迟", gwMs(s.ttftAvg), "", false)}
        ${gwStatCard("总时长均值", gwMs(s.msAvg), "", false)}
      </div>
      <div class="gwbars">${bars}</div>
      <div class="gwbaraxis"><span>${esc(d.daily[0] ? d.daily[0].date : "")}</span><span>近 14 天</span><span>${esc(d.daily.length ? d.daily[d.daily.length - 1].date : "")}</span></div>
      <div class="gwnote">
        记账只存<b>量纲</b>（token 数、延迟、状态码、走了哪家哪个 key），
        <b>不存请求与响应正文</b>。网关经手全部对话内容，落一份副本到磁盘与这个工具的定位不符。
        <br>标记 <code>estimated</code> 的行是上游没回 usage、按字符数估的，界面上的数字会混在一起 ——
        要精确计费请以供应商账单为准。
      </div>
    </div>
    <div class="gwcard">
      <h3>按供应商</h3>
      <div class="gwtablewrap"><table class="gwtable">
        <thead><tr><th>供应商</th><th>调用</th><th>失败</th><th>输入</th><th>输出</th></tr></thead>
        <tbody>${provRows || '<tr><td colspan="5" class="muted">暂无数据</td></tr>'}</tbody>
      </table></div>
    </div>
    <div class="gwcard">
      <h3>按模型 <span class="sub">前 40</span></h3>
      <div class="gwtablewrap"><table class="gwtable">
        <thead><tr><th>模型</th><th>调用</th><th>失败</th><th>输入</th><th>输出</th></tr></thead>
        <tbody>${modelRows || '<tr><td colspan="5" class="muted">暂无数据</td></tr>'}</tbody>
      </table></div>
    </div>
  `;
}

// ---- 端点页 ----
function gwRenderEndpoints() {
  const d = gw.data;
  const base = location.origin;
  const ep = [
    ["Chat", base + d.endpoints.chat],
    ["Responses", base + d.endpoints.responses],
    ["Anthropic", base + d.endpoints.anthropic],
    ["模型列表", base + d.endpoints.models],
  ];

  $("#gwp-endpoints").innerHTML = `
    <div class="gwcard">
      <h3>接入端点 <span class="sub">any agent 配 base_url 都指向这里</span></h3>
      <div class="gwep">
        ${ep.map(([k, v]) => `<div class="r"><span class="k">${k}</span><code>${esc(v)}</code>
          <button onclick="gwCopy('${escAttr(v)}',this)">复制</button></div>`).join("")}
      </div>
      <div class="gwnote">
        <b>Claude Code</b>：<code>ANTHROPIC_BASE_URL=${esc(base)}</code>（<b>不带</b> /v1）、
        <code>ANTHROPIC_AUTH_TOKEN=${d.tokenRequired ? "&lt;你设的口令&gt;" : "opensession"}</code>
        <br><b>Codex</b>：<code>base_url = "${esc(base)}/v1"</code>、<code>wire_api = "responses"</code>
        <br><b>Pi</b>：<code>baseUrl = "${esc(base)}/v1"</code>、<code>api = "openai-completions"</code>
        <br>「Agent 指向」页可以一键写进这三家，不用手改。
      </div>
      ${d.tokenRequired ? `<div class="gwnote warn">
        已设 <code>OPENSESSION_GW_TOKEN</code>，请求必须带
        <code>Authorization: Bearer &lt;口令&gt;</code> 或 <code>x-api-key</code>。</div>` : `<div class="gwnote warn">
        未设 <code>OPENSESSION_GW_TOKEN</code>：任何能访问本机 8347 端口的进程都能通过网关调用你的付费模型。
        本机自用可以，<b>别把端口暴露到公网</b>。需要口令时设这个环境变量后重启服务。</div>`}
    </div>
    <div class="gwcard">
      <h3>配置文件</h3>
      <div class="gwep">
        <div class="r"><span class="k">配置</span><code>${esc(d.configPath)}</code></div>
        <div class="r"><span class="k">用量</span><code>${esc(d.usagePath)}</code></div>
        <div class="r"><span class="k">密钥</span><code>${esc(d.configPath.replace("gateway.json", "gateway-keys.json"))}</code></div>
      </div>
      <div class="gwnote">
        配置是纯 JSON，可以直接手改；服务按 mtime 自动重读，不用重启。
        密钥单独存一个 600 权限的文件，所以把 <code>gateway.json</code> 发给别人不会带出密钥。
      </div>
    </div>
  `;
}

// ---- 交互 ----

async function gwToggleEnabled() {
  const next = !gw.data.enabled;
  try {
    await gwFetch("/api/gw/settings", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: next }),
    });
    await gwLoad();
    toast(next ? "网关已启用" : "网关已关闭");
  } catch (e) { toast("失败：" + e.message); }
}

function gwEditProvider(id) {
  gw.editing = id === undefined ? null : (id || "new");
  gwRender();
  if (gw.editing) $("#gwform")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function gwSaveProvider(id, btn) {
  if (gw.busy) return;
  gw.busy = true;
  btn.disabled = true;
  try {
    const keysRaw = $("#gwkeys").value.trim();
    // 支持 "name:sk-xxx" 与纯 key 两种写法，一行一个或逗号分隔
    const keys = keysRaw
      ? keysRaw.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean).map((s) => {
          const i = s.indexOf(":");
          return i > 0 && !s.startsWith("sk-") ? { name: s.slice(0, i).trim(), key: s.slice(i + 1).trim() } : { key: s };
        })
      : null;

    const body = {
      name: $("#gwname").value.trim(),
      url: $("#gwurl").value.trim(),
      anthropic: $("#gwanthropic").value.trim(),
      responses: $("#gwresponses").value.trim(),
      models: $("#gwmodels").value.split(/[\s,]+/).filter(Boolean),
      note: $("#gwnote").value.trim(),
    };
    if (keys) body.keys = keys;

    if (id) {
      body.action = "update"; body.id = id;
      await gwFetch("/api/gw/provider", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
    } else {
      body.action = "add";
      body.id = $("#gwid").value.trim() || undefined;
      await gwFetch("/api/gw/provider", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
    }
    gw.editing = null;
    await gwLoad();
    toast(id ? "已保存" : "已添加");
  } catch (e) { toast("失败：" + e.message); }
  finally { gw.busy = false; btn.disabled = false; }
}

async function gwToggleProvider(id, on) {
  try {
    await gwFetch("/api/gw/provider", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "update", id, enabled: on }),
    });
    await gwLoad();
  } catch (e) { toast("失败：" + e.message); }
}

async function gwDelProvider(id, name) {
  if (!confirm(`删除供应商「${name}」？\n\n它的密钥会被一并清掉，路由组里引用它的成员也会移除。\n已产生的用量记录保留。`)) return;
  try {
    await gwFetch("/api/gw/provider", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "remove", id }),
    });
    await gwLoad();
    toast("已删除");
  } catch (e) { toast("失败：" + e.message); }
}

async function gwRemoveKey(id, index) {
  if (!confirm("删除这把密钥？")) return;
  try {
    await gwFetch("/api/gw/provider", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "removeKey", id, index }),
    });
    await gwLoad();
  } catch (e) { toast("失败：" + e.message); }
}

async function gwTestProvider(id, btn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = "测试中…";
  try {
    const r = await gwFetch("/api/gw/provider", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "test", id }),
    });
    if (r.ok) {
      toast(`${id} 连通 · ${r.status} · ${r.ms}ms · ${r.model}`);
      btn.textContent = `${r.ms}ms ✓`;
    } else {
      // 失败时把上游原话带出来 —— "密钥无效" 和 "模型不存在" 是两种完全不同的修法
      toast(`${id} 失败 ${r.status || ""}：${String(r.error || "").slice(0, 70)}`);
      btn.textContent = "失败 ✕";
    }
  } catch (e) {
    toast("测试失败：" + e.message);
    btn.textContent = "失败 ✕";
  }
  setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 2600);
}

async function gwToggleDefault() {
  const ids = gw.data.providers.map((p) => p.id);
  if (!ids.length) return toast("先添加供应商");
  const cur = ids.indexOf(gw.data.defaultProvider);
  const next = ids[(cur + 1) % ids.length];
  try {
    await gwFetch("/api/gw/settings", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultProvider: next }),
    });
    await gwLoad();
    toast("默认供应商：" + next);
  } catch (e) { toast("失败：" + e.message); }
}

function gwEditGroup(name) {
  gw.groupEdit = name === undefined ? null : name;
  gwRender();
}

async function gwSaveGroup(name, btn) {
  btn.disabled = true;
  try {
    const models = $("#ggmodels").value.split("\n").map((s) => s.trim()).filter(Boolean);
    const body = {
      name: name || $("#ggname").value.trim(),
      models,
      routing: $("#ggrouting").value,
    };
    body.action = name ? "update" : "add";
    await gwFetch("/api/gw/group", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    gw.groupEdit = null;
    await gwLoad();
    toast(name ? "已保存" : "已创建");
  } catch (e) { toast("失败：" + e.message); }
  finally { btn.disabled = false; }
}

async function gwDelGroup(name) {
  if (!confirm(`删除路由组「${name}」？`)) return;
  try {
    await gwFetch("/api/gw/group", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "remove", name }),
    });
    await gwLoad();
  } catch (e) { toast("失败：" + e.message); }
}

async function gwApplyAgent(agent, btn) {
  const model = ($("#gwagentmodel").value || "").trim();
  if (!model) return toast("先填「指向时使用的模型」");
  if (!confirm(`把 ${agent} 指向本网关（模型 ${model}）？\n\n会先备份原配置到 ~/.config/opensession/agent-backups/。\n改完需要重启该 agent 才生效。`)) return;
  btn.disabled = true;
  try {
    const r = await gwFetch("/api/gw/agents", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "apply", agent, model }),
    });
    toast(`${agent} 已指向网关，备份：${String(r.backup || "").split("/").pop()}`);
    await gwRenderAgents();
  } catch (e) { toast("失败：" + e.message); }
  finally { btn.disabled = false; }
}

async function gwRestoreAgent(agent, btn) {
  if (!confirm(`把 ${agent} 还原到上次「指向」之前的配置？`)) return;
  btn.disabled = true;
  try {
    await gwFetch("/api/gw/agents", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "restore", agent }),
    });
    toast(agent + " 已还原");
    await gwRenderAgents();
  } catch (e) { toast("失败：" + e.message); }
  finally { btn.disabled = false; }
}

async function gwRange(n) {
  gw.range = n;
  await gwLoad();
}

async function gwClearUsage() {
  if (!confirm("清空网关用量记录？此操作不可撤销（配置不受影响）。")) return;
  try {
    await gwFetch("/api/gw/usage", { method: "DELETE" });
    await gwLoad();
    toast("用量已清空");
  } catch (e) { toast("失败：" + e.message); }
}

function gwCopy(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    const old = btn.textContent;
    btn.textContent = "已复制";
    setTimeout(() => { btn.textContent = old; }, 1400);
  }).catch(() => toast("复制失败，请手动选中"));
}
