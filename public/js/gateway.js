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
  if (typeof gwClosePicker === "function") gwClosePicker();
}

// 模型面板的关外与 Esc。挂在 document 上而不是面板节点：
// 面板每次点开都是新节点，绑在节点上会随 remove() 一起丢掉。
document.addEventListener("click", (e) => {
  const pop = document.getElementById("gwpicker");
  if (!pop) return;
  if (pop.contains(e.target)) return;
  // 点到那个「展开按钮」本身时别关 —— 它自己的 click 会负责开关，
  // 这里再关一次会导致「点开立刻又关掉」
  if (e.target.closest && e.target.closest(".gwpick")) return;
  gwClosePicker();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") gwClosePicker();
});

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
          <span class="kn">${k.name ? esc(k.name) : "#" + (i + 1)}</span>
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
//
// 界面结构参照 magpie 的 Agents 页：
//
//   [图标] 名称                              Tiers ›  [模型 ▾]   (开关)
//          状态行（连没连、走哪个地址）
//
// 三条是从 magpie 学来的、实测确实更好的做法：
//
//   1. **开关不带文字**。magpie 就是一个裸滑块，开与关靠位置和颜色区分。
//      之前我写「已开启 / 已关闭」两个字，两行并排看着像标签而不像控件，
//      而且要占 50px 宽 —— 那一段正是窄屏最先挤爆的地方。
//   2. **模型字段是按钮，点开一个可搜索面板**，不是 <input> + <datalist>。
//      datalist 在 Chrome 里既不能按供应商分组、也不会显示「这家还剩几个模型」，
//      30 多个模型平铺下来只能靠记住名字去猜。面板按供应商分组，可搜索。
//   3. **状态行说事实**，不写「走 OpenSession」这种结论。之前那句话误导过：
//      判定只看 provider 名，base_url 写成 /v1（实际 404）也打勾。
//
// 模型仍然是**按工具分开**的：claude 走 Anthropic 协议、codex 只认 Responses、
// pi 的清单是网关注入的、dsh 连 -m 都没有。共用一个值 = 改成 A 家模型 B 家报错。
async function gwRenderAgents() {
  const el = $("#gwp-agents");
  // 🔴 重绘前把各行的**未提交输入**存下来。
  // 不存的话：用户填好三行，只点其中一个开关，渲染回来另外两行
  // 就被「已保存的模型」覆盖成空 —— 白填。这是实测出来的问题。
  const typed = {};
  document.querySelectorAll(".gwm").forEach((i) => {
    if (i.dataset.agent) typed[i.dataset.agent] = i.value;
  });
  el.innerHTML = `<div class="gwcard"><div class="gwempty">读取中…</div></div>`;
  let a;
  try { a = await gwFetch("/api/gw/agents"); }
  catch (e) { el.innerHTML = `<div class="gwcard"><div class="gwempty">读取失败：${esc(e.message)}</div></div>`; return; }

  const models = gw.data.models || [];
  const saved = a.agentModels || {};

  // 回填优先级：草稿 > 本地记下的 > 配置文件里当前生效的 > 空
  //
  // 🔴 当前生效的模型**不一定在网关清单里**（claude 的 `sonnet`、
  // codex 走中转站时的 `gpt-6.2-sol` 都是）。预填这种值等于挖坑：
  // 用户不改直接开开关 → 校验不通过 → 报「模型不在清单里」。
  const inCatalog = (m) => models.includes(m);
  const pick = (key, curModel) => {
    if (typed[key] !== undefined && typed[key] !== "") return typed[key];
    if (saved[key]) return saved[key];
    return inCatalog(curModel) ? curModel : "";
  };

  // 状态行：只摆事实（地址、模型、provider），不下结论
  const statusOf = (cur) => {
    if (!cur.found) {
      return `<span class="st-off">未找到配置</span>
        <span class="st-dim">${esc(shortPath(cur.configFile))}</span>`;
    }
    const bits = [];
    if (cur.baseUrl) bits.push(`<code>${esc(shortBase(cur.baseUrl))}</code>`);
    // Claude 的实际生效值是 env 四档，顶层 model 不作数
    const envVals = cur.models ? Object.values(cur.models).filter(Boolean) : [];
    const uniq = [...new Set(envVals)];
    if (uniq.length === 1) bits.push(`<code>${esc(uniq[0])}</code>`);
    else if (uniq.length > 1) {
      bits.push(esc(Object.entries(cur.models).filter(([, v]) => v)
        .map(([k, v]) => `${k}=${v}`).join(" ")));
    } else if (cur.model) bits.push(`<code>${esc(cur.model)}</code>`);
    if (cur.brokenBase) {
      return `<span class="st-warn">地址少了 /gw，请求会 404 —— 关掉再开即可修正</span>
        ${bits.length ? `<span class="st-dim">${bits.join(" · ")}</span>` : ""}`;
    }
    if (cur.viaGateway) {
      return `<span class="st-on">已接入</span> ${bits.join(" · ")}`;
    }
    // dsh 有两个 profile，状态不一致时必须说出来：只用 web 版的人会以为
    // 已经全好了，而终端里 `dsh headless "…"` 还在跑旧供应商。
    if (cur.split) {
      const detail = (cur.profiles || [])
        .map((p) => `${(p.file || "").includes("/headless/") ? "headless" : "web"} ${p.provider || "?"}`)
        .join(" · ");
      return `<span class="st-warn">两个 profile 状态不一致</span>
        <span class="st-dim">${esc(detail)}</span>`;
    }
    // 没接入：说清楚它现在走的是哪儿，而不是只说「未接入」
    if (cur.provider) bits.unshift(`provider <code>${esc(shortProvider(cur.provider))}</code>`);
    if (cur.modelProvider) bits.unshift(`provider <code>${esc(shortProvider(cur.modelProvider))}</code>`);
    return `<span class="st-off">未接入</span>
      ${bits.length ? `<span class="st-dim">${bits.join(" · ")}</span>` : ""}`;
  };

  // 图标用**首字母**而不是 emoji：本机字体缺 🅰 之类的字形，实测渲染成空心方框。
  // 首字母在任何字体下都在，而且四个字母 C/C/P/D 区分度足够。
  const ICONS = { claude: "C", codex: "X", pi: "P", dsh: "D", hermes: "H" };

  const row = (key, label, cur, supported, extra) => {
    const envVals = cur.models ? [...new Set(Object.values(cur.models).filter(Boolean))] : [];
    const effective = envVals.length === 1 ? envVals[0] : (cur.model || "");
    const val = pick(key, effective);
    // 「另选」徽标只看**用户选没选**，不看配置文件里的旧值。
    // 之前按 effective 判断：用户从面板里选好了一个清单内的模型，
    // 徽标还赖在按钮上（旧模型的锅），看着像没选中。
    const offCatalog = supported && effective && !inCatalog(effective) && !val;
    const on = supported && cur.viaGateway;
    const showVal = val || (effective && !inCatalog(effective) ? effective : "");
    return `<div class="gwagent${on ? " on" : ""}">
      <span class="ico">${ICONS[key] || "•"}</span>
      <span class="amain">
        <span class="an">${label}</span>
        <span class="ast">${statusOf(cur)}${extra || ""}</span>
      </span>
      <span class="apick">
        ${supported
          ? `<button type="button" class="gwpick${showVal && inCatalog(showVal) ? "" : " empty"}${offCatalog ? " warn" : ""}"
               onclick="gwPickModel(event,'${key}')"
               aria-haspopup="listbox" aria-expanded="false"
               title="${offCatalog
                 ? escAttr(`当前生效的 ${effective} 不在网关清单里，点开另选一个才能接入`)
                 : (showVal ? escAttr(showVal) : "选择一个模型")}">
               <span class="pv">${showVal ? esc(showVal) : "选择模型…"}</span>
               ${offCatalog ? `<span class="pkbadge">另选</span>` : ""}
               <span class="caret">▾</span>
             </button>
             <input class="gwm" id="gwm-in-${key}" data-agent="${key}" type="hidden"
               value="${escAttr(val)}">`
          : ""}
      </span>
      <span class="acts">
        ${supported
          ? `<button class="gwtoggle${on ? " on" : ""}" role="switch" aria-checked="${on ? "true" : "false"}"
               aria-label="${label} ${on ? "已接入网关，点击关闭" : "未接入网关，点击开启"}"
               onclick="gwToggleAgent('${key}',this)" title="${on ? "关闭：配置回到开启之前" : "开启：把该工具指到本网关"}">
               <span class="knob"></span>
             </button>`
            + (on ? `<button class="gwundo" onclick="gwRestoreAgent('${key}',this)"
               title="退回上一次改动之前的备份（与开关的「回到开启之前」不同）">还原</button>` : "")
          : `<span class="ro">只读</span>`}
      </span>
    </div>`;
  };

  el.innerHTML = `
    <div class="gwcard">
      <div class="gwhint">开关打开后，该 CLI 的请求改走本网关；开关上方的模型字段决定它用哪个模型。
        每个工具各配各的 —— Claude 走 Anthropic 协议，Codex 只认 Responses，
        同一个模型名并非处处可用。</div>
      <div class="gwlist">
        ${row("claude", "Claude Code", a.claude, true)}
        ${row("codex", "Codex", a.codex, true)}
        ${row("pi", "Pi", a.pi, true)}
        ${row("dsh", "DeepSeek", a.dsh, true)}
        ${row("hermes", "Hermes", a.hermes, true)}
      </div>
      <div class="gwnote">
        <b>开关关闭时配置回到「开启之前那一刻」</b>，不是回到厂商默认 —— 你原来配的中转站不会丢。
        开启期间改过模型的，用「还原」退回上一次改动前。
        改动前一律强制备份到 <code>~/.config/opensession/agent-backups/</code>，
        只改自己写的那几个键，其余（modelPicker / statusLine / 其他 provider / 注释与段顺序）原样保留。
        <br><b>地址带 <code>/gw</code></b>：网关入口是 <code>/gw/v1/*</code>，根下的 <code>/v1/*</code> 不接请求。
        <br><b>dsh 会同时改 web 与 headless 两份 profile</b>：只改一份的话，终端里
        <code>dsh headless "…"</code> 还在用旧供应商。
        <br><b>YAML 文件按行改，不重排</b>：注释、缩进、<code>!!js</code> 表达式、段顺序都原样留着。
      </div>
    </div>
  `;
}

// 长的配置路径只留末尾两段 —— 整条路径在窄屏上会把状态行挤成三行
function shortPath(p) {
  if (!p) return "";
  const parts = String(p).split("/").filter(Boolean);
  return parts.length <= 2 ? String(p) : "…/" + parts.slice(-2).join("/");
}

// 地址去掉 `http://` —— 网关只监听 127.0.0.1，协议对读者没有信息量，
// 但占掉 7 个字符，360px 下正好把 `.../gw` 推到第二行去。
// https 保留：那说明它指向的是外部服务，性质不同，不该被抹掉。
function shortBase(u) {
  const s = String(u || "");
  // 本机地址去协议（网关只监听 127.0.0.1，协议没信息量，却占 7 个字符）
  if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(s)) {
    return s.replace(/^https?:\/\//i, "");
  }
  // 外部地址去协议、去路径，只留主机 —— 状态行不是配置面板，
  // 用户在这里只需要知道「它现在打到哪家」，完整地址在配置文件里。
  try {
    const u2 = new URL(s);
    return u2.host;
  } catch { return s; }
}

// hermes 的 provider 名带 `custom:` 前缀（`custom:moapi`），
// 那是它内部区分「内置 provider」与「自定义 provider」的写法。
// 状态行里显示 `custom:moapi` 只会让人以为多了个叫 custom 的家。
function shortProvider(p) {
  return String(p || "").replace(/^custom:/i, "");
}

// ---- 模型选择面板（参照 magpie 的 picker）----
//
// 为什么不用 <input list=...> 的 datalist：
//   · Chrome 里不能分组，30+ 个模型平铺，找一家得从头滚
//   · 不能搜索（只有前缀补全，且输入框里会留下你打的字）
//   · 不显示「这家有几个模型」，也不显示模型来自哪家
// magpie 的做法是点开一个按供应商分组、顶部带搜索框的浮层，这里照做。
function gwClosePicker() {
  const old = document.getElementById("gwpicker");
  if (old) old.remove();
  document.querySelectorAll(".gwpick[aria-expanded=true]")
    .forEach((b) => b.setAttribute("aria-expanded", "false"));
}

function gwPickModel(ev, agent) {
  if (ev) { ev.preventDefault(); ev.stopPropagation(); }
  const btn = ev && ev.currentTarget;
  const wasOpen = document.getElementById("gwpicker");
  gwClosePicker();
  if (wasOpen && btn && wasOpen.dataset.agent === agent) return;

  const box = document.getElementById("gwm-in-" + agent);
  const curVal = box ? box.value : "";
  const models = gw.data.models || [];

  // 按前缀分组：`moapi/GLM-5.2` → 组 moapi，条目 GLM-5.2
  // 路由组（group/xxx）单独排在最前，因为它是「一条规则」而不是「一家的模型」
  const byProv = new Map();
  for (const m of models) {
    const i = m.indexOf("/");
    const p = i < 0 ? "" : m.slice(0, i);
    if (!byProv.has(p)) byProv.set(p, []);
    byProv.get(p).push(m);
  }
  const order = [...byProv.keys()].sort((x, y) =>
    (x === "group" ? -1 : y === "group" ? 1 : x.localeCompare(y)));
  const groups = order.map((p) => ({ prov: p, items: byProv.get(p) }));

  // 条目里只在「模型名 ≠ 组名」时补后缀。
  // 路由组是 group/xxx，条目已经叫 xxx 了，再挂一个 `group` 纯属噪声；
  // 供应商组则是 moapi/GLM-5.2 这种，后面标 moapi 能帮人确认是哪家。
  const itemHtml = (m) => {
    const i = m.indexOf("/");
    const prov = i < 0 ? "" : m.slice(0, i);
    const name = i < 0 ? m : m.slice(i + 1);
    const showProv = prov && prov !== "group" && prov !== name;
    return `<button type="button" class="pkitem${m === curVal ? " sel" : ""}"
      data-m="${escAttr(m)}" onclick="gwChooseModel('${agent}','${escAttr(m)}')">
      <span class="pn">${esc(name)}</span>
      ${showProv ? `<span class="pp">${esc(prov)}</span>` : '<span class="pp"></span>'}
      ${m === curVal ? '<span class="tick">✓</span>' : ""}
    </button>`;
  };

  const list = groups.map((g) => `
    <div class="pkgrp" data-prov="${escAttr(g.prov)}">
      <div class="pkgt">${esc(g.prov === "group" ? "路由组" : g.prov)}
        <span class="cnt">${g.items.length}</span></div>
      ${g.items.map(itemHtml).join("")}
    </div>`).join("");

  const pop = document.createElement("div");
  pop.id = "gwpicker";
  pop.dataset.agent = agent;
  pop.className = "gwpicker";
  // 面板要有标题：手机档面板会盖住整片列表，不写「给谁选」的话
  // 用户只看得见一列模型名，不知道自己在改哪一行的配置。
  const LABELS = { claude: "Claude Code", codex: "Codex", pi: "Pi", dsh: "DeepSeek", hermes: "Hermes" };
  pop.innerHTML = `
    <div class="pkhead">选择 <b>${esc(LABELS[agent] || agent)}</b> 使用的模型</div>
    <div class="pksearch">
      <input type="text" id="gwpk-q" placeholder="搜索模型，或直接输入名字" spellcheck="false"
        autocomplete="off">
    </div>
    <div class="pklist" id="gwpk-list">${list || '<div class="gwempty">网关里还没有模型</div>'}</div>`;
  document.body.appendChild(pop);

  if (btn) {
    btn.setAttribute("aria-expanded", "true");
    // 贴着按钮下方展开、右对齐；越界就夹进视口（手机档按钮靠右，右对齐会探出去）
    const r = btn.getBoundingClientRect();
    const w = pop.getBoundingClientRect().width;
    const pad = 8;
    let left = Math.min(Math.max(pad, r.right - w), window.innerWidth - pad - w);
    let top = r.bottom + 6;
    // 下方放不下就翻到上方
    const h = pop.getBoundingClientRect().height;
    if (top + h > window.innerHeight - pad && r.top - h - 6 > pad) top = r.top - h - 6;
    pop.style.left = Math.max(pad, left) + "px";
    pop.style.top = top + "px";
  }

  const q = document.getElementById("gwpk-q");
  if (q) {
    q.addEventListener("input", () => {
      const k = q.value.trim().toLowerCase();
      document.querySelectorAll("#gwpk-list .pkitem").forEach((it) => {
        it.style.display = !k || it.dataset.m.toLowerCase().includes(k) ? "" : "none";
      });
      // 组内一条都不剩就把组标题也藏掉，否则会留一堆空标题
      document.querySelectorAll("#gwpk-list .pkgrp").forEach((g) => {
        const any = [...g.querySelectorAll(".pkitem")].some((i) => i.style.display !== "none");
        g.style.display = any ? "" : "none";
      });
    });
    setTimeout(() => q.focus(), 0);
  }
}

// 选定：写回隐藏输入 + 更新按钮文字。不立即写配置 ——
// 用户可能只是在挑，拨开关那一刻才真正落盘（与 magpie 一致）。
function gwChooseModel(agent, m) {
  const box = document.getElementById("gwm-in-" + agent);
  if (box) box.value = m;
  const btn = document.querySelector(`.gwpick[aria-expanded="true"]`)
    || document.querySelector(`.gwagent .gwpick[onclick*="'${agent}'"]`);
  gwClosePicker();
  // 重绘这一页：状态行要跟着改（模型变了，「不在清单里」的提示也该消失）
  gwRenderAgents();
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
      // 换过模型时要说明「前几个不通、这个通了」—— 否则用户以为第一个就是好的
      const skipped = (r.attempts || []).filter((a) => !a.ok);
      const tail = skipped.length
        ? `（${skipped.map((a) => a.model).join("、")} 不通，换到这个）`
        : "";
      toast(`${id} 连通 · ${r.status} · ${r.ms}ms · ${r.model}${tail}`);
      btn.textContent = `${r.ms}ms ✓`;
    } else {
      // 失败时把上游原话带出来 —— "密钥无效" 和 "模型不存在" 是两种完全不同的修法。
      // 试过多个模型时列出各自的状态，让用户能分清「整站不通」与「模型全下线」。
      const tried = (r.attempts || []).map((a) => `${a.model}=${a.status || "ERR"}`).join("，");
      const more = r.total > r.tried ? `（共 ${r.total} 个模型，只试了前 ${r.tried} 个）` : "";
      toast(`${id} 失败 ${r.status || ""}：${String(r.error || "").slice(0, 50)}${tried ? " · " + tried : ""}${more}`);
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

// 开关：一个按钮两态，不再并排「指向网关 / 还原」两个动词。
// 开着时点它 = 关闭（回到开启之前），关着时点它 = 开启。
//
// 这里保留「还原」的独立入口（长按 / 右键不动，指到说明里）——
// 关闭用定版快照，还原用时间戳备份，语义不同：
//   关闭 = 回到你**推开这扇门之前**的样子
//   还原 = 回到**上一次改动之前**（含开启后改模型那一次）
async function gwToggleAgent(agent, btn) {
  const cur = btn.getAttribute("aria-checked") === "true";
  const box = document.getElementById("gwm-in-" + agent);
  const model = ((box && box.value) || "").trim();
  if (cur) {
    if (!confirm(`关闭 ${agent} 的网关接入？\n\n配置会回到你开启之前的样子（不是回到厂商默认）。`)) return;
  } else {
    if (!model) return toast("先填 " + agent + " 要用的模型");
    const others = [...document.querySelectorAll(".gwm")]
      .filter((x) => x.dataset.agent !== agent && x.value.trim() === model)
      .map((x) => x.dataset.agent);
    const warn = others.length
      ? `\n\n注意：${others.join(" / ")} 也在用同一个模型名，若那家不支持会说模型不存在。`
      : "";
    if (!confirm(`开启 ${agent} 的网关接入（模型 ${model}）？${warn}\n\n会先备份原配置，改完需要重启该 agent 才生效。`)) return;
  }
  btn.disabled = true;
  try {
    const r = await gwFetch("/api/gw/agents", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cur ? { action: "off", agent } : { action: "apply", agent, model }),
    });
    if (cur) {
      const n = (r.restored || []).length;
      const sk = (r.skipped || [])[0];
      toast(n ? `${agent} 已关闭，配置回到开启之前` : `关闭未完成：${sk ? sk.reason : "没有可用的快照"}`);
    } else {
      toast(`${agent} 已接入网关（${model}）`);
    }
    await gwRenderAgents();
    await gwRefreshModelCatalog();
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
    await gwRefreshModelCatalog();
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
