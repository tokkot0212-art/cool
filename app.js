// 冷蔵庫コンシェルジュ
// データはこの端末のブラウザ（localStorage）にだけ保存されます。
"use strict";

const STORE_KEY = "fridge-concierge-v1";
const QTY_OPTIONS = ["10", "9", "8", "7", "6", "5", "4", "3", "2", "1", "1/2", "0"];
const FOOD_GROUPS = ["野菜", "肉", "魚", "卵・乳製品", "大豆・加工品", "主食", "果物", "冷凍食品", "乾物"];

// ---------- 状態 ----------
function defaultState() {
  return {
    items: [],
    places: DEFAULT_PLACES.slice(),
    history: [],
    learn: { recipe: {}, global: {} },
    aiRecipes: [],
    requests: [],
    infos: [],
    settings: {
      apiKey: "",
      model: "gemini-flash-latest",
      supermarket: "",
      area: "",
      tools: "ホットクック、フライパン、電子レンジ",
      policy: "地中海式の食事をゆるく取り入れたい。簡単に作れることを重視。",
    },
  };
}
function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return defaultState();
    const d = Object.assign(defaultState(), JSON.parse(raw));
    d.settings = Object.assign(defaultState().settings, d.settings || {});
    d.learn = Object.assign({ recipe: {}, global: {} }, d.learn || {});
    return d;
  } catch (e) {
    console.error(e);
    return defaultState();
  }
}
let S = load();
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); }
  catch (e) { toast("保存できませんでした（容量不足の可能性）"); }
}

// 画面の一時状態（保存しない）
const UI = {
  tab: "fridge",
  fridgeView: "place", // place | expiry
  selectMode: false,
  selected: new Set(), // レシピに使う食材ID
  regGroup: "野菜",
  regSearch: "",
  drafts: [],
  recipeQuery: "",
  aiResults: [],
  aiLoading: false,
  aiMessage: "",
  extraTab: "requests",
  infoLoading: false,
  infoMessage: "",
  modalCtx: null,
};

// ---------- ユーティリティ ----------
const $ = (sel, root = document) => root.querySelector(sel);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function ymd(d) {
  const z = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}
function today() { return ymd(new Date()); }
function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + n);
  return ymd(d);
}
function daysUntil(dateStr) {
  if (!dateStr) return null;
  const a = new Date(today() + "T00:00:00"), b = new Date(dateStr + "T00:00:00");
  return Math.round((b - a) / 86400000);
}
function fmtDate(dateStr) {
  if (!dateStr) return "";
  const [, m, d] = dateStr.split("-");
  return `${Number(m)}/${Number(d)}`;
}
function qtyNum(q) { return q === "1/2" ? 0.5 : Number(q || 0); }
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), 2400);
}
function stars(n, size = "") {
  let s = "";
  for (let i = 1; i <= 5; i++) s += `<span class="star ${i <= n ? "on" : ""} ${size}">★</span>`;
  return s;
}
function nextWeekday(dow) { // 0=日 ... 6=土
  const d = new Date();
  const diff = (dow - d.getDay() + 7) % 7 || 7;
  d.setDate(d.getDate() + diff);
  return ymd(d);
}

// ---------- マスター参照・期限 ----------
function foodMaster(name) { return FOOD_MASTER.find((f) => f[0] === name); }
function seasMaster(name) { return SEASONING_MASTER.find((f) => f[0] === name); }

function defaultExpiry(item) {
  const base = item.bought || today();
  if (item.cat === "調味料") {
    const m = seasMaster(item.name);
    return addDays(base, m ? m[2] : 90);
  }
  const m = foodMaster(item.name);
  let days;
  if (item.storage === "冷凍") days = m ? (m[6] || 30) : 30;
  else if (item.storage === "常温") days = m ? (m[2] === "常温" ? m[5] : Math.max(1, Math.round(m[5] / 2))) : 14;
  else days = m ? (m[5] || 5) : 5;
  return addDays(base, days);
}
function expiryOf(item) { return item.expiryManual || defaultExpiry(item); }

function newItemFromName(name, catHint) {
  const fm = foodMaster(name);
  const sm = seasMaster(name);
  if (sm || catHint === "調味料") {
    const storage = sm ? sm[1] : "常温";
    return { id: uid(), name, cat: "調味料", storage, place: storage === "冷蔵" ? "ドアポケット" : "常温", qty: "1", unit: "本", bought: today(), expiryManual: "", buyMethod: "", note: "" };
  }
  if (fm) {
    return { id: uid(), name, cat: fm[2] === "常温" ? "常温" : "食材", storage: fm[2], place: fm[3], qty: "1", unit: fm[4], bought: today(), expiryManual: "", buyMethod: "", note: "" };
  }
  const storage = catHint === "常温" ? "常温" : "冷蔵";
  return { id: uid(), name, cat: catHint === "常温" ? "常温" : "食材", storage, place: storage === "常温" ? "常温" : "中段", qty: "1", unit: "個", bought: today(), expiryManual: "", buyMethod: "", note: "" };
}
const isFreezer = (p) => String(p).includes("冷凍");
function normalizeItem(it) {
  // 保存方法とカテゴリ・場所の整合をとる
  if (it.cat !== "調味料") it.cat = it.storage === "常温" ? "常温" : "食材";
  const freezers = S.places.filter(isFreezer), fridges = S.places.filter((p) => !isFreezer(p));
  if (it.storage === "常温") it.place = "常温";
  else if (it.storage === "冷凍") { if (!freezers.includes(it.place)) it.place = freezers[0] || "冷凍"; }
  else if (!fridges.includes(it.place)) {
    const m = foodMaster(it.name);
    it.place = m && fridges.includes(m[3]) ? m[3] : (fridges.includes("中段") ? "中段" : fridges[0] || "中段");
  }
  return it;
}

// ---------- レシピのマッチング・学習 ----------
function stockItems() { return S.items.filter((i) => i.qty !== "0"); }
function hasInStock(key, pool) {
  const names = key.split("|");
  return pool.find((i) => names.some((n) => i.name === n || i.name.includes(n))) || null;
}
function allRecipes() { return RECIPES.concat(S.aiRecipes); }
function recipeById(id) { return allRecipes().find((r) => r.id === id) || UI.aiResults.find((r) => r.id === id); }
function ratingOf(recipeId) {
  const hs = S.history.filter((h) => h.recipeId === recipeId && h.rating);
  if (!hs.length) return null;
  return { avg: hs.reduce((a, h) => a + h.rating, 0) / hs.length, n: hs.length };
}
function weightedFactor(list) {
  if (!list || !list.length) return null;
  let w = 0, s = 0;
  list.forEach((e) => { const ww = Math.max(1, e.rating || 3); w += ww; s += e.ratio * ww; });
  return Math.min(3, Math.max(0.3, s / w));
}
function learnedAmount(recipeId, name, base, unit, isSeasoning) {
  if (!base || unit === "少々") return { amt: base, factor: 1, source: null };
  const rec = S.learn.recipe[recipeId] && S.learn.recipe[recipeId][name];
  let f = weightedFactor(rec), source = f ? "recipe" : null;
  if (!f && isSeasoning) { f = weightedFactor(S.learn.global[name]); source = f ? "global" : null; }
  f = f || 1;
  return { amt: roundAmt(base * f, unit), factor: f, source };
}
function roundAmt(v, unit) {
  if (unit === "g" || unit === "ml") return Math.max(1, Math.round(v / 5) * 5);
  return Math.max(0.25, Math.round(v * 4) / 4);
}
function fmtAmt(a, unit) {
  if (unit === "少々") return "少々";
  const n = Number(a);
  const s = Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
  if (unit === "大さじ" || unit === "小さじ") return `${unit}${s}`;
  return `${s}${unit}`;
}
function scoreRecipe(r) {
  const pool = stockItems();
  const sel = S.items.filter((i) => UI.selected.has(i.id));
  const parts = r.parts || [];
  let have = [], missing = [], selHits = 0, expBonus = 0;
  parts.forEach((p) => {
    const it = hasInStock(p[0], pool);
    if (it) {
      have.push(it.name);
      if (sel.some((s) => s.id === it.id)) selHits++;
      const du = daysUntil(expiryOf(it));
      if (du != null && du <= 2) expBonus += 4;
    } else missing.push(p[0].split("|")[0]);
  });
  const seasRegistered = S.items.some((i) => i.cat === "調味料");
  const seasMissing = seasRegistered ? (r.seas || []).filter((s) => !hasInStock(s[0], pool)).map((s) => s[0].split("|")[0]) : [];
  const rt = ratingOf(r.id);
  let score = selHits * 12 + have.length * 3 - missing.length * 4 - seasMissing.length + expBonus;
  if (rt) score += (rt.avg - 3) * 4;
  return { r, have, missing, seasMissing, selHits, rating: rt, score, expBonus };
}
function matchedRecipes() {
  const q = UI.recipeQuery.trim();
  let list = allRecipes().map(scoreRecipe);
  if (q) list = list.filter((x) => x.r.t.includes(q) || (x.r.c || "").includes(q) || (x.r.parts || []).some((p) => p[0].includes(q)));
  else if (UI.selected.size) list = list.filter((x) => x.selHits > 0);
  else list = list.filter((x) => x.have.length > 0 && x.missing.length <= 1);
  return list.sort((a, b) => b.score - a.score).slice(0, 30);
}

// ---------- Gemini ----------
async function gemini(prompt, { json = false, search = false } = {}) {
  const key = S.settings.apiKey.trim();
  if (!key) throw new Error("設定でGeminiのAPIキーを入れてください");
  const model = (S.settings.model || "gemini-flash-latest").trim();
  const body = { contents: [{ role: "user", parts: [{ text: prompt }] }] };
  if (json) body.generationConfig = { responseMimeType: "application/json" };
  if (search) body.tools = [{ google_search: {} }];
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.error && data.error.message) || `Gemini エラー (${res.status})`);
  const cand = (data.candidates || [])[0] || {};
  const text = ((cand.content && cand.content.parts) || []).map((p) => p.text || "").join("");
  const sources = ((cand.groundingMetadata && cand.groundingMetadata.groundingChunks) || [])
    .map((c) => c.web).filter(Boolean).map((w) => ({ uri: w.uri, title: w.title }));
  return { text, sources };
}
function extractJSON(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const src = fence ? fence[1] : text;
  try { return JSON.parse(src); } catch (e) { /* 続けて探す */ }
  const a = src.indexOf("["), b = src.lastIndexOf("]");
  if (a >= 0 && b > a) { try { return JSON.parse(src.slice(a, b + 1)); } catch (e) { /* noop */ } }
  const c = src.indexOf("{"), d = src.lastIndexOf("}");
  if (c >= 0 && d > c) { try { return JSON.parse(src.slice(c, d + 1)); } catch (e) { /* noop */ } }
  throw new Error("Geminiの返答を読み取れませんでした。もう一度試してください");
}
function tasteProfileText() {
  const lines = [];
  const g = S.learn.global;
  Object.keys(g).forEach((name) => {
    const f = weightedFactor(g[name]);
    if (f && Math.abs(f - 1) >= 0.1) lines.push(`${name}は基本の${f.toFixed(1)}倍が好み`);
  });
  const best = favoriteDishes().filter((d) => d.avg >= 4).slice(0, 6).map((d) => d.title);
  const worst = favoriteDishes().filter((d) => d.avg <= 2).slice(0, 4).map((d) => d.title);
  return { seasoning: lines.join("、") || "まだ学習データなし", best: best.join("、") || "なし", worst: worst.join("、") || "なし" };
}
function normalizeAiRecipe(o) {
  const arr = (x) => (Array.isArray(x) ? x : []);
  const pair = (p) => Array.isArray(p) ? [String(p[0] || ""), Number(p[1]) || 0, String(p[2] || "")]
    : [String(p.name || ""), Number(p.amount) || 0, String(p.unit || "")];
  const t = String(o.t || o.title || "提案レシピ");
  return {
    id: "ai_" + t.replace(/\s/g, "").slice(0, 24) + "_" + (String(o.c || o.country || "").slice(0, 6)),
    t, c: String(o.c || o.country || ""), tool: String(o.tool || ""), time: Number(o.time) || 0,
    parts: arr(o.parts).map(pair).filter((p) => p[0]),
    seas: arr(o.seas || o.seasonings).map(pair).filter((p) => p[0]),
    steps: arr(o.steps).map(String), why: String(o.why || ""), ai: true,
  };
}
async function askGeminiRecipes(mode) {
  const sel = S.items.filter((i) => UI.selected.has(i.id));
  const stock = stockItems();
  if (mode === "world" && !sel.length) { toast("食材を1つ選んでください"); return; }
  const tp = tasteProfileText();
  const stockText = stock.filter((i) => i.cat !== "調味料").map((i) => `${i.name}(残り${i.qty}${i.unit}・期限${fmtDate(expiryOf(i))})`).join("、") || "なし";
  const seasText = stock.filter((i) => i.cat === "調味料").map((i) => i.name).join("、") || "一般的な家庭の調味料";
  const selText = sel.map((i) => i.name).join("、");
  let task;
  if (mode === "world") {
    task = `食材「${sel[0].name}」1つを主役にして、3つの異なる国・地域の特有の食べ方を1品ずつ提案してください。現地の調味料がなくても、日本のスーパーで手に入る調味料で近い味を再現する工夫を入れてください。`;
  } else {
    task = `${selText ? `選んだ食材（${selText}）を必ず使い、` : "冷蔵庫の食材を使って、"}今夜作れる料理を3品提案してください。1つの食材だけで作れる料理でもかまいません。期限が近い食材を優先してください。`;
  }
  const prompt = `あなたは家庭の冷蔵庫コンシェルジュです。${task}
# 冷蔵庫・常温の食材
${stockText}
# ある調味料
${seasText}
# 使える調理器具
${S.settings.tools}
# 食事の方針
${S.settings.policy}
# 家族の好み（過去の評価から学習）
- 高評価の料理: ${tp.best}
- 低評価の料理: ${tp.worst}
- 味付けの傾向: ${tp.seasoning}
# 出力
2人分。次の形のJSON配列だけを返してください。
[{"t":"料理名","c":"国・地域","tool":"主な調理器具","time":分(数値),"parts":[["食材名",量(数値),"単位"]],"seas":[["調味料名",量(数値),"単位(大さじ/小さじ/g/ml/少々)"]],"steps":["手順1","手順2"],"why":"おすすめの理由(1文)"}]
食材名は可能なら次の表記に合わせてください: ${stock.map((i) => i.name).join("、")}`;
  UI.aiLoading = true; UI.aiMessage = ""; render();
  try {
    const { text } = await gemini(prompt, { json: true });
    let data = extractJSON(text);
    if (!Array.isArray(data)) data = data.recipes || [data];
    UI.aiResults = data.map(normalizeAiRecipe);
    UI.aiMessage = UI.aiResults.length ? "" : "提案が見つかりませんでした";
  } catch (e) {
    UI.aiMessage = e.message;
  } finally {
    UI.aiLoading = false; render();
  }
}
async function refreshInfos() {
  const area = [S.settings.area, S.settings.supermarket].filter(Boolean).join(" ") || "日本の一般的なスーパー";
  const prompt = `家庭料理を手軽に楽しくするための買い物情報を、Google検索で最新の情報を確認して10件ください。
- 9件: 便利な調理器具・食材・調味料。Amazonで買えるもの、または「${area}」のような近くのスーパーで買えるもの。価格の目安も。
- 1件（全体の10%）: 過去1か月にネット記事で話題になった食べ物や食べ方（トレンド）。
- 今の食事の方針: ${S.settings.policy}
- 使う調理器具: ${S.settings.tools}
次の形のJSON配列だけを返してください（説明文は不要）。
[{"kind":"調理器具|食材|調味料|トレンド","title":"名前","desc":"1〜2文の説明","where":"Amazon|スーパー|ネット記事","price":"価格の目安(不明なら空)","url":"参考URL(わからなければ空)"}]`;
  UI.infoLoading = true; UI.infoMessage = ""; render();
  try {
    const { text, sources } = await gemini(prompt, { search: true });
    let data = extractJSON(text);
    if (!Array.isArray(data)) data = data.items || [data];
    const now = today();
    const batch = data.slice(0, 10).map((o) => ({
      id: uid(), kind: String(o.kind || "食材"), title: String(o.title || ""), desc: String(o.desc || ""),
      where: String(o.where || ""), price: String(o.price || ""), url: /^https?:\/\//.test(o.url || "") ? o.url : "", date: now, auto: true,
    })).filter((x) => x.title);
    // トレンドは1割に保つ
    const trends = batch.filter((b) => b.kind === "トレンド");
    const others = batch.filter((b) => b.kind !== "トレンド");
    const finalBatch = others.slice(0, 9).concat(trends.slice(0, 1));
    S.infos = finalBatch.concat(S.infos).slice(0, 80);
    S.infoSources = sources.slice(0, 8);
    save();
    UI.infoMessage = `${finalBatch.length}件を更新しました（トレンド${Math.min(1, trends.length)}件）`;
  } catch (e) {
    UI.infoMessage = e.message;
  } finally {
    UI.infoLoading = false; render();
  }
}

// ---------- 集計 ----------
function favoriteDishes() {
  const map = {};
  S.history.forEach((h) => {
    const k = h.recipeId || h.title;
    map[k] = map[k] || { recipeId: h.recipeId, title: h.title, sum: 0, n: 0, last: h.date };
    if (h.rating) { map[k].sum += h.rating; map[k].n++; }
    if (h.date > map[k].last) map[k].last = h.date;
  });
  return Object.values(map).filter((d) => d.n).map((d) => Object.assign(d, { avg: d.sum / d.n })).sort((a, b) => b.avg - a.avg || b.n - a.n);
}

// ---------- 描画 ----------
function render() {
  document.querySelectorAll("#tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.tab === UI.tab));
  const v = $("#view");
  const map = { fridge: viewFridge, pantry: viewPantry, register: viewRegister, recipe: viewRecipe, history: viewHistory, extra: viewExtra, settings: viewSettings };
  v.innerHTML = (map[UI.tab] || viewFridge)();
}

function conciergeMessage() {
  const foods = stockItems().filter((i) => i.cat !== "調味料");
  const h = new Date().getHours();
  const greet = h < 10 ? "おはようございます。" : h < 17 ? "こんにちは。" : "おかえりなさい。";
  if (!S.items.length) {
    return { text: `${greet}冷蔵庫コンシェルジュです。まずは「登録」タブで、今ある食材と調味料を教えてください。`, action: `<button class="btn primary" data-action="tab" data-tab="register">食材を登録する</button>` };
  }
  const soon = foods.map((i) => ({ i, d: daysUntil(expiryOf(i)) })).filter((x) => x.d != null && x.d <= 2).sort((a, b) => a.d - b.d);
  if (soon.length) {
    const top = soon[0];
    const when = top.d < 0 ? "期限を過ぎているかもしれません" : top.d === 0 ? "今日まで" : top.d === 1 ? "明日まで" : "あさってまで";
    const others = soon.length > 1 ? `（ほかに${soon.length - 1}品も近いです）` : "";
    return { text: `${greet}「${top.i.name}」が${when}です${others}。使いますか？`, action: `<button class="btn primary" data-action="cook-with" data-id="${top.i.id}">${esc(top.i.name)}でレシピを見る</button>` };
  }
  const empty = S.items.filter((i) => i.qty === "0");
  if (empty.length) {
    return { text: `${greet}期限の近い食材はありません。買い足しメモ：${empty.slice(0, 6).map((i) => i.name).join("、")}`, action: "" };
  }
  return { text: `${greet}冷蔵庫に${foods.length}品あります。今日は何を作りましょう？`, action: `<button class="btn primary" data-action="tab" data-tab="recipe">今作れる料理を見る</button>` };
}

function badgeFor(item) {
  const d = daysUntil(expiryOf(item));
  if (item.qty === "0") return `<span class="badge gray">なし</span>`;
  if (d == null) return "";
  if (d < 0) return `<span class="badge red">期限切れ?</span>`;
  if (d <= 1) return `<span class="badge red">${d === 0 ? "今日" : "明日"}まで</span>`;
  if (d <= 3) return `<span class="badge orange">あと${d}日</span>`;
  return `<span class="badge">あと${d}日</span>`;
}
function itemChip(item) {
  const sel = UI.selected.has(item.id);
  return `<button class="chip item-chip ${sel ? "selected" : ""} ${item.qty === "0" ? "empty" : ""}" data-action="${UI.selectMode ? "toggle-select" : "edit-item"}" data-id="${item.id}">
    <span class="chip-name">${sel ? "✓ " : ""}${esc(item.name)}</span>
    <span class="chip-qty">${esc(item.qty)}${esc(item.unit)}</span>
    ${badgeFor(item)}
  </button>`;
}

function viewFridge() {
  const m = conciergeMessage();
  const foods = S.items.filter((i) => i.cat === "食材");
  let body;
  if (UI.fridgeView === "place") {
    const places = S.places.filter((p) => !isFreezer(p)).concat(S.places.filter(isFreezer));
    const known = new Set(places);
    const orphan = foods.filter((i) => !known.has(i.place));
    body = `<div class="fridge-map">` + places.map((p) => {
      const list = foods.filter((i) => i.place === p).sort((a, b) => (expiryOf(a) > expiryOf(b) ? 1 : -1));
      return `<section class="shelf ${isFreezer(p) ? "freezer" : ""} ${p === "野菜室" ? "veg" : ""}">
        <h3>${esc(p)} <small>${list.length}品</small></h3>
        <div class="chips">${list.map(itemChip).join("") || `<span class="muted">空いています</span>`}</div>
      </section>`;
    }).join("") + (orphan.length ? `<section class="shelf"><h3>場所未設定</h3><div class="chips">${orphan.map(itemChip).join("")}</div></section>` : "") + `</div>`;
  } else {
    const list = foods.slice().sort((a, b) => (a.qty === "0") - (b.qty === "0") || (expiryOf(a) > expiryOf(b) ? 1 : -1));
    body = `<div class="list">${list.map((i) => `<div class="row">${itemChip(i)}<span class="muted small">${esc(i.place)}・期限${fmtDate(expiryOf(i))}</span></div>`).join("") || `<p class="muted">まだ食材がありません</p>`}</div>`;
  }
  return `
  <div class="concierge">
    <div class="avatar">🧊</div>
    <div class="bubble"><p>${esc(m.text)}</p>${m.action}</div>
  </div>
  <div class="toolbar">
    <div class="seg">
      <button class="${UI.fridgeView === "place" ? "on" : ""}" data-action="fridge-view" data-v="place">場所別</button>
      <button class="${UI.fridgeView === "expiry" ? "on" : ""}" data-action="fridge-view" data-v="expiry">期限順</button>
    </div>
    <button class="btn ${UI.selectMode ? "accent" : ""}" data-action="toggle-select-mode">${UI.selectMode ? "選択をやめる" : "食材を選んでレシピ"}</button>
  </div>
  ${UI.selectMode ? `<div class="select-bar">選んだ食材：${UI.selected.size}品 <button class="btn primary" data-action="go-recipe" ${UI.selected.size ? "" : "disabled"}>このレシピを探す</button></div>` : ""}
  ${body}`;
}

function viewPantry() {
  const room = S.items.filter((i) => i.cat === "常温");
  const seas = S.items.filter((i) => i.cat === "調味料");
  const row = (i) => `<button class="list-row" data-action="edit-item" data-id="${i.id}">
      <span class="name">${esc(i.name)}</span>
      <span class="muted small">${esc(i.qty)}${esc(i.unit)}${i.cat === "調味料" ? `・${esc(i.storage)}` : ""}${i.note ? `・${esc(i.note)}` : ""}</span>
      ${badgeFor(i)}
    </button>`;
  return `
  <h2>常温の食材</h2>
  <p class="muted small">冷蔵しない食材（玉ねぎ・じゃがいも・米・缶詰など）</p>
  <div class="list">${room.map(row).join("") || `<p class="muted">まだありません</p>`}</div>
  <h2>調味料</h2>
  <p class="muted small">期限は開封後のおおよその目安です</p>
  <div class="list">${seas.map(row).join("") || `<p class="muted">まだありません</p>`}</div>
  <div class="center"><button class="btn primary" data-action="tab" data-tab="register">食材・調味料を追加する</button></div>`;
}

// 共通の食材フォーム（登録・編集で使う）
function itemFormHTML(it, ctx) {
  const placeOpts = it.storage === "常温" ? ["常温"] : it.storage === "冷凍" ? S.places.filter(isFreezer) : S.places.filter((p) => !isFreezer(p));
  const d0 = today(), d1 = addDays(d0, -1), d2 = addDays(d0, -2);
  const exp = expiryOf(it);
  return `
  <div class="form" data-ctx="${ctx}">
    <div class="field"><label>残量</label>
      <div class="qty-grid">${QTY_OPTIONS.map((q) => `<button class="qty ${it.qty === q ? "on" : ""}" data-action="set-field" data-ctx="${ctx}" data-field="qty" data-value="${q}">${q}</button>`).join("")}</div>
      <div class="inline"><span class="muted small">単位</span><input class="small-input" data-bind="unit" data-ctx="${ctx}" value="${esc(it.unit)}"></div>
    </div>
    <div class="field"><label>購入日</label>
      <div class="seg">
        <button class="${it.bought === d0 ? "on" : ""}" data-action="set-field" data-ctx="${ctx}" data-field="bought" data-value="${d0}">今日</button>
        <button class="${it.bought === d1 ? "on" : ""}" data-action="set-field" data-ctx="${ctx}" data-field="bought" data-value="${d1}">昨日</button>
        <button class="${it.bought === d2 ? "on" : ""}" data-action="set-field" data-ctx="${ctx}" data-field="bought" data-value="${d2}">2日前</button>
      </div>
      <input type="date" class="date-sm" data-bind="bought" data-ctx="${ctx}" data-rerender="1" value="${esc(it.bought)}">
    </div>
    <div class="field"><label>保存方法</label>
      <div class="seg">${["冷蔵", "冷凍", "常温"].map((s) => `<button class="${it.storage === s ? "on" : ""}" data-action="set-field" data-ctx="${ctx}" data-field="storage" data-value="${s}">${s}</button>`).join("")}</div>
    </div>
    <div class="field"><label>場所</label>
      <div class="seg wrap">${placeOpts.map((p) => `<button class="${it.place === p ? "on" : ""}" data-action="set-field" data-ctx="${ctx}" data-field="place" data-value="${esc(p)}">${esc(p)}</button>`).join("")}</div>
    </div>
    <div class="field"><label>購入方法</label>
      <input data-bind="buyMethod" data-ctx="${ctx}" placeholder="例：近所のスーパー、ネットスーパー、直売所" value="${esc(it.buyMethod)}">
    </div>
    <div class="field"><label>賞味期限の目安</label>
      <div class="inline"><strong>${fmtDate(exp)}</strong> ${it.expiryManual ? `<span class="muted small">（手動）</span><button class="link" data-action="set-field" data-ctx="${ctx}" data-field="expiryManual" data-value="">目安に戻す</button>` : `<span class="muted small">（一般的な目安から自動）</span>`}</div>
      <details class="small"><summary>期限を自分で決める</summary><input type="date" data-bind="expiryManual" data-ctx="${ctx}" data-rerender="1" value="${esc(it.expiryManual || "")}"></details>
    </div>
    <div class="field"><label>メモ</label>
      <input data-bind="note" data-ctx="${ctx}" placeholder="例：半分は冷凍済み" value="${esc(it.note)}">
    </div>
  </div>`;
}

function viewRegister() {
  const q = UI.regSearch.trim();
  const groups = FOOD_GROUPS.concat(["調味料"]);
  const registered = new Set(S.items.map((i) => i.name));
  const drafting = new Set(UI.drafts.map((d) => d.name));
  let names;
  if (q) {
    names = FOOD_MASTER.map((f) => f[0]).concat(SEASONING_MASTER.map((s) => s[0])).filter((n) => n.includes(q));
  } else if (UI.regGroup === "調味料") names = SEASONING_MASTER.map((s) => s[0]);
  else names = FOOD_MASTER.filter((f) => f[1] === UI.regGroup).map((f) => f[0]);
  return `
  <h2>食材・調味料を登録</h2>
  <p class="muted small">タップで選んで、下で残量や場所を入れてから「まとめて登録」。</p>
  <input class="search" placeholder="名前で探す（例：トマト）" data-bind-ui="regSearch" value="${esc(UI.regSearch)}">
  ${q ? "" : `<div class="seg wrap group-tabs">${groups.map((g) => `<button class="${UI.regGroup === g ? "on" : ""}" data-action="reg-group" data-g="${g}">${g}</button>`).join("")}</div>`}
  <div class="chips master">${names.map((n) => `<button class="chip ${drafting.has(n) ? "selected" : ""}" data-action="toggle-draft" data-name="${esc(n)}">${drafting.has(n) ? "✓ " : ""}${esc(n)}${registered.has(n) ? `<small class="muted"> 登録済</small>` : ""}</button>`).join("") || `<span class="muted">見つかりません。下で自由に追加できます</span>`}</div>
  <div class="custom-add">
    <input id="custom-name" placeholder="リストにない物の名前" value="${q && !names.includes(q) ? esc(q) : ""}">
    <select id="custom-cat"><option value="食材">食材（冷蔵）</option><option value="常温">常温の食材</option><option value="調味料">調味料</option></select>
    <button class="btn" data-action="add-custom">追加</button>
  </div>
  ${UI.drafts.length ? `
  <h2>選んだもの（${UI.drafts.length}）</h2>
  ${UI.drafts.map((d, i) => `<div class="card draft">
      <div class="card-head"><strong>${esc(d.name)}</strong><span class="muted small">${esc(d.cat)}</span><button class="link danger" data-action="remove-draft" data-i="${i}">外す</button></div>
      ${itemFormHTML(d, "d:" + i)}
    </div>`).join("")}
  <div class="sticky-actions"><button class="btn primary big" data-action="commit-drafts">まとめて登録（${UI.drafts.length}品）</button></div>` : ""}`;
}

function recipeCard(x) {
  const r = x.r;
  return `<button class="card recipe-card" data-action="open-recipe" data-id="${esc(r.id)}">
    <div class="card-head"><strong>${esc(r.t)}</strong><span class="tag">${esc(r.c || "")}</span></div>
    <div class="muted small">${esc(r.tool || "")}${r.time ? `・約${r.time}分` : ""}${x.rating ? `・${stars(Math.round(x.rating.avg), "sm")} (${x.rating.n}回)` : ""}${r.ai ? "・Gemini提案" : ""}</div>
    <div class="small">使う：${esc(x.have.join("、") || "—")}</div>
    ${x.missing.length ? `<div class="small warn">足りない：${esc(x.missing.join("、"))}</div>` : `<div class="small ok">食材はそろっています</div>`}
    ${x.seasMissing.length ? `<div class="small muted">調味料なし：${esc(x.seasMissing.join("、"))}</div>` : ""}
    ${x.expBonus ? `<span class="badge orange">期限が近い食材を使えます</span>` : ""}
    ${r.why ? `<div class="small muted">💡 ${esc(r.why)}</div>` : ""}
  </button>`;
}

function viewRecipe() {
  const foods = S.items.filter((i) => i.cat !== "調味料" && i.qty !== "0");
  const sel = foods.filter((i) => UI.selected.has(i.id));
  const list = matchedRecipes();
  const ai = UI.aiResults.map(scoreRecipe);
  return `
  <h2>今作れる料理</h2>
  <div class="card">
    <div class="card-head"><strong>使いたい食材</strong><span class="muted small">タップで選択（1つだけでもOK）</span>${UI.selected.size ? `<button class="link" data-action="clear-select">選択を解除</button>` : ""}</div>
    <div class="chips">${foods.sort((a, b) => (expiryOf(a) > expiryOf(b) ? 1 : -1)).map((i) => `<button class="chip ${UI.selected.has(i.id) ? "selected" : ""}" data-action="toggle-select" data-id="${i.id}">${UI.selected.has(i.id) ? "✓ " : ""}${esc(i.name)} ${badgeFor(i)}</button>`).join("") || `<span class="muted">在庫がありません。「登録」から追加してください</span>`}</div>
    <input class="search" placeholder="料理名・国名で探す（例：カレー、韓国）" data-bind-ui="recipeQuery" data-rerender="1" value="${esc(UI.recipeQuery)}">
  </div>
  <div class="ai-box card">
    <div class="card-head"><strong>Geminiに相談</strong>${S.settings.apiKey ? "" : `<span class="muted small">設定でAPIキーを入れると使えます</span>`}</div>
    <div class="btn-row">
      <button class="btn" data-action="ai-recipes" ${UI.aiLoading ? "disabled" : ""}>${sel.length ? "選んだ食材で3品提案" : "冷蔵庫の中身で3品提案"}</button>
      <button class="btn" data-action="ai-world" ${UI.aiLoading || sel.length !== 1 ? "disabled" : ""}>🌍 ${sel.length === 1 ? esc(sel[0].name) + "を世界の食べ方で" : "1食材を世界の食べ方で（1つ選択）"}</button>
    </div>
    ${UI.aiLoading ? `<p class="muted">考えています…</p>` : ""}
    ${UI.aiMessage ? `<p class="warn small">${esc(UI.aiMessage)}</p>` : ""}
    ${ai.length ? `<div class="grid">${ai.map(recipeCard).join("")}</div>` : ""}
  </div>
  <h3>手持ちのレシピ集から（${list.length}件）</h3>
  <p class="muted small">評価の高い料理・期限が近い食材を使う料理を上に並べます</p>
  <div class="grid">${list.map(recipeCard).join("") || `<p class="muted">合うレシピが見つかりません。食材を選び直すか、Geminiに相談してください</p>`}</div>`;
}

function recipeDetailHTML(r) {
  const pool = stockItems();
  const amtRow = (p, isSeas) => {
    const la = learnedAmount(r.id, p[0], p[1], p[2], isSeas);
    const have = hasInStock(p[0], pool);
    const note = la.source === "recipe" ? `<span class="learned">あなた好みに調整（×${la.factor.toFixed(2)}）</span>` : la.source === "global" ? `<span class="learned">好みの傾向から調整</span>` : "";
    return `<li><span class="${have || isSeas ? "" : "warn"}">${esc(p[0].replace(/\|/g, " / "))}</span><span>${fmtAmt(la.amt, p[2])} ${note}</span></li>`;
  };
  const rt = ratingOf(r.id);
  const past = S.history.filter((h) => h.recipeId === r.id).slice(-3).reverse();
  return `
  <div class="modal-head"><h2>${esc(r.t)}</h2><button class="icon-btn" data-action="close-modal">✕</button></div>
  <p class="muted">${esc(r.c || "")}${r.tool ? `・${esc(r.tool)}` : ""}${r.time ? `・約${r.time}分` : ""}・2人分${rt ? `・${stars(Math.round(rt.avg), "sm")}` : ""}</p>
  ${r.why ? `<p class="small">💡 ${esc(r.why)}</p>` : ""}
  <h3>材料</h3><ul class="amounts">${(r.parts || []).map((p) => amtRow(p, false)).join("")}</ul>
  <h3>調味料</h3><ul class="amounts">${(r.seas || []).map((p) => amtRow(p, true)).join("")}</ul>
  <h3>作り方</h3><ol class="steps">${(r.steps || []).map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
  ${past.length ? `<h3>過去のメモ</h3><ul class="small">${past.map((h) => `<li>${fmtDate(h.date)} ${stars(h.rating, "sm")} ${esc(h.memo || "")}</li>`).join("")}</ul>` : ""}
  <div class="btn-row">
    <button class="btn primary big" data-action="cook" data-id="${esc(r.id)}">作った！評価する</button>
    ${r.ai && !S.aiRecipes.some((x) => x.id === r.id) ? `<button class="btn" data-action="save-ai" data-id="${esc(r.id)}">レシピ集に保存</button>` : ""}
  </div>`;
}

function cookFormHTML(r) {
  const pool = stockItems();
  const rows = [];
  (r.parts || []).forEach((p) => rows.push({ name: p[0], base: p[1], unit: p[2], seas: false }));
  (r.seas || []).forEach((p) => rows.push({ name: p[0], base: p[1], unit: p[2], seas: true }));
  const used = [];
  (r.parts || []).forEach((p) => { const it = hasInStock(p[0], pool); if (it && !used.includes(it)) used.push(it); });
  UI.modalCtx = { kind: "cook", recipeId: r.id, rating: 0, rows };
  return `
  <div class="modal-head"><h2>${esc(r.t)} を作りました</h2><button class="icon-btn" data-action="close-modal">✕</button></div>
  <div class="field"><label>評価（次回の提案に反映）</label>
    <div class="rate" id="rate">${[1, 2, 3, 4, 5].map((n) => `<button class="star big" data-action="rate" data-n="${n}">★</button>`).join("")}</div>
  </div>
  <div class="field"><label>実際に使った量（直すと次回から好みの量に近づきます）</label>
    <table class="amount-table">${rows.map((row, i) => {
      const la = learnedAmount(r.id, row.name, row.base, row.unit, row.seas);
      if (row.unit === "少々" || !row.base) return `<tr><td>${esc(row.name.split("|")[0])}</td><td colspan="2" class="muted">少々</td></tr>`;
      return `<tr><td>${esc(row.name.split("|")[0])}</td>
        <td><input type="number" step="0.25" min="0" inputmode="decimal" data-amt="${i}" value="${la.amt}"></td>
        <td class="muted small">${esc(row.unit)}（基本 ${fmtAmt(row.base, row.unit)}）</td></tr>`;
    }).join("")}</table>
  </div>
  ${used.length ? `<div class="field"><label>使った食材の残量</label>
    ${used.map((it) => `<div class="inline used-row"><span>${esc(it.name)}</span>
      <select data-used="${it.id}">${QTY_OPTIONS.map((q) => `<option ${q === it.qty ? "selected" : ""}>${q}</option>`).join("")}</select><span class="muted small">${esc(it.unit)}</span></div>`).join("")}
  </div>` : ""}
  <div class="field form"><label>メモ</label><input id="cook-memo" placeholder="例：醤油は少なめが良かった"></div>
  <button class="btn primary big" data-action="save-cook">記録する</button>`;
}

function viewHistory() {
  const fav = favoriteDishes();
  const tp = [];
  Object.keys(S.learn.global).forEach((n) => {
    const f = weightedFactor(S.learn.global[n]);
    if (f && Math.abs(f - 1) >= 0.05) tp.push(`${n} ×${f.toFixed(2)}`);
  });
  const hist = S.history.slice().reverse();
  return `
  <h2>作った料理の記録</h2>
  ${fav.length ? `<div class="card"><div class="card-head"><strong>家族の好きな料理</strong></div>
    <ol class="fav">${fav.slice(0, 8).map((d) => `<li><button class="link" data-action="open-recipe" data-id="${esc(d.recipeId || "")}">${esc(d.title)}</button> ${stars(Math.round(d.avg), "sm")} <span class="muted small">${d.n}回</span></li>`).join("")}</ol></div>` : ""}
  ${tp.length ? `<div class="card"><div class="card-head"><strong>学習した味付けの傾向</strong><span class="muted small">基本の量に対する倍率</span></div><p class="small">${esc(tp.join("　"))}</p></div>` : ""}
  <div class="list">${hist.map((h) => `<div class="card hist">
      <div class="card-head"><strong>${esc(h.title)}</strong><span class="muted small">${fmtDate(h.date)}${h.country ? `・${esc(h.country)}` : ""}</span></div>
      <div class="rate">${[1, 2, 3, 4, 5].map((n) => `<button class="star ${n <= h.rating ? "on" : ""}" data-action="rerate" data-id="${h.id}" data-n="${n}">★</button>`).join("")}</div>
      ${h.memo ? `<p class="small">${esc(h.memo)}</p>` : ""}
      <div class="btn-row"><button class="link" data-action="open-recipe" data-id="${esc(h.recipeId || "")}">もう一度作る</button><button class="link danger" data-action="del-history" data-id="${h.id}">削除</button></div>
    </div>`).join("") || `<p class="muted">まだ記録がありません。レシピを開いて「作った！」を押すとここに残ります</p>`}</div>`;
}

function viewExtra() {
  const sub = `<div class="seg"><button class="${UI.extraTab === "requests" ? "on" : ""}" data-action="extra-tab" data-t="requests">家族のリクエスト</button><button class="${UI.extraTab === "infos" ? "on" : ""}" data-action="extra-tab" data-t="infos">お役立ち情報</button></div>`;
  return sub + (UI.extraTab === "requests" ? viewRequests() : viewInfos());
}
function viewRequests() {
  const names = [...new Set(S.requests.map((r) => r.who).filter(Boolean))];
  const sat = nextWeekday(6), sat2 = addDays(nextWeekday(6), 7);
  const list = S.requests.slice().sort((a, b) => (a.done - b.done) || ((a.planned || "9999") > (b.planned || "9999") ? 1 : -1));
  return `
  <h2>家族のリクエスト</h2>
  <p class="muted small">面倒な料理（たこ焼きなど）も、まずはメモとして受け付け。いつやるかは仮決めでOK。</p>
  <div class="card form">
    <div class="field"><label>だれから</label><input id="rq-who" placeholder="例：娘" list="rq-names"><datalist id="rq-names">${names.map((n) => `<option value="${esc(n)}">`).join("")}</datalist></div>
    <div class="field"><label>食べたい料理</label><input id="rq-dish" placeholder="例：たこ焼き"></div>
    <div class="field"><label>メモ</label><input id="rq-note" placeholder="例：タコは苦手なのでウインナーで"></div>
    <div class="field"><label>いつやる？（仮）</label>
      <div class="seg"><button data-action="rq-date" data-v="${sat}">今週末</button><button data-action="rq-date" data-v="${sat2}">来週末</button><button data-action="rq-date" data-v="">未定</button></div>
      <input type="date" id="rq-date">
    </div>
    <button class="btn primary" data-action="add-request">リクエストを受け付ける</button>
  </div>
  <div class="list">${list.map((r) => `<div class="card ${r.done ? "done" : ""}">
    <div class="card-head"><strong>${esc(r.dish)}</strong><span class="muted small">${esc(r.who || "")}</span></div>
    <div class="small">${r.planned ? `予定：${fmtDate(r.planned)}（仮）` : "予定：未定"}${r.note ? `・${esc(r.note)}` : ""}</div>
    <div class="btn-row">
      <button class="link" data-action="req-recipe" data-dish="${esc(r.dish)}">レシピを探す</button>
      <button class="link" data-action="req-done" data-id="${r.id}">${r.done ? "未完了に戻す" : "作った！"}</button>
      <button class="link danger" data-action="req-del" data-id="${r.id}">削除</button>
    </div></div>`).join("") || `<p class="muted">リクエストはまだありません</p>`}</div>`;
}
function infoLink(i) {
  if (i.url) return i.url;
  const q = encodeURIComponent(i.title);
  if (i.where.includes("Amazon")) return `https://www.amazon.co.jp/s?k=${q}`;
  if (i.where.includes("スーパー")) return `https://www.google.com/search?q=${encodeURIComponent((S.settings.supermarket || "スーパー") + " " + i.title)}`;
  return `https://www.google.com/search?q=${q}`;
}
function viewInfos() {
  const total = S.infos.length, trend = S.infos.filter((i) => i.kind === "トレンド").length;
  const kinds = ["調理器具", "食材", "調味料", "トレンド"];
  return `
  <h2>便利な調理器具・食材・調味料</h2>
  <p class="muted small">Amazonや近くのスーパーの情報。更新するたびに10件のうち1件（10%）は、過去1か月にネットで話題になった食べ物・食べ方を入れます。</p>
  <div class="btn-row">
    <button class="btn primary" data-action="refresh-infos" ${UI.infoLoading || !S.settings.apiKey ? "disabled" : ""}>🔄 最新情報に更新（Gemini＋Google検索）</button>
    ${S.settings.apiKey ? "" : `<span class="muted small">設定でAPIキーを入れると自動更新できます</span>`}
  </div>
  ${UI.infoLoading ? `<p class="muted">検索しています…（30秒ほどかかることがあります）</p>` : ""}
  ${UI.infoMessage ? `<p class="small">${esc(UI.infoMessage)}</p>` : ""}
  <p class="muted small">全${total}件・うちトレンド${trend}件${total ? `（${Math.round((trend / total) * 100)}%）` : ""}</p>
  ${kinds.map((k) => {
    const list = S.infos.filter((i) => i.kind === k);
    if (!list.length) return "";
    return `<h3>${k === "トレンド" ? "🔥 " : ""}${k}</h3><div class="grid">${list.map((i) => `<div class="card info">
      <div class="card-head"><strong>${esc(i.title)}</strong><span class="tag">${esc(i.where || "")}</span></div>
      <p class="small">${esc(i.desc)}</p>
      <div class="small muted">${i.price ? `目安：${esc(i.price)}・` : ""}${fmtDate(i.date)}更新</div>
      <div class="btn-row"><a class="link" href="${esc(infoLink(i))}" target="_blank" rel="noopener">${i.url ? "参考ページ" : "検索する"}</a><button class="link danger" data-action="del-info" data-id="${i.id}">削除</button></div>
    </div>`).join("")}</div>`;
  }).join("")}
  ${(S.infoSources || []).length ? `<details class="small"><summary>前回の更新で参照したページ</summary><ul>${S.infoSources.map((s) => `<li><a href="${esc(s.uri)}" target="_blank" rel="noopener">${esc(s.title || s.uri)}</a></li>`).join("")}</ul></details>` : ""}
  <div class="card form">
    <div class="card-head"><strong>自分で追加</strong></div>
    <div class="inline"><select id="if-kind">${kinds.map((k) => `<option>${k}</option>`).join("")}</select><select id="if-where"><option>Amazon</option><option>スーパー</option><option>ネット記事</option><option>その他</option></select></div>
    <input id="if-title" placeholder="名前（例：シリコンスチーマー）">
    <input id="if-desc" placeholder="ひとこと（例：レンジ蒸しが5分）">
    <input id="if-url" placeholder="URL（任意）">
    <button class="btn" data-action="add-info">追加</button>
  </div>`;
}

function viewSettings() {
  const st = S.settings;
  return `
  <h2>設定</h2>
  <div class="card form">
    <div class="card-head"><strong>冷蔵庫の場所</strong><span class="muted small">最初は仮でOK。あとで自由に変えられます</span></div>
    ${S.places.map((p, i) => `<div class="inline place-row">
      <input data-place="${i}" value="${esc(p)}">
      <button class="icon-btn" data-action="place-up" data-i="${i}" ${i === 0 ? "disabled" : ""}>↑</button>
      <button class="icon-btn" data-action="place-del" data-i="${i}">🗑</button></div>`).join("")}
    <div class="inline"><input id="new-place" placeholder="新しい場所（例：チルド2段目）"><button class="btn" data-action="place-add">追加</button></div>
    <button class="btn" data-action="place-save">場所の名前を保存</button>
  </div>
  <div class="card form">
    <div class="card-head"><strong>Gemini（AI）</strong></div>
    <p class="muted small">Google AI Studio で取得したAPIキーを入れると、レシピ提案とお役立ち情報の自動更新が使えます。キーはこの端末のブラウザにだけ保存されます。</p>
    <div class="field"><label>APIキー</label><input type="password" id="st-key" value="${esc(st.apiKey)}" autocomplete="off"></div>
    <div class="field"><label>モデル名</label><input id="st-model" value="${esc(st.model)}"></div>
  </div>
  <div class="card form">
    <div class="card-head"><strong>わが家のこと</strong></div>
    <div class="field"><label>よく行くスーパー</label><input id="st-super" value="${esc(st.supermarket)}" placeholder="例：〇〇スーパー △△店"></div>
    <div class="field"><label>地域</label><input id="st-area" value="${esc(st.area)}" placeholder="例：〇〇市"></div>
    <div class="field"><label>使う調理器具</label><input id="st-tools" value="${esc(st.tools)}"></div>
    <div class="field"><label>食事の方針</label><textarea id="st-policy" rows="2">${esc(st.policy)}</textarea></div>
  </div>
  <button class="btn primary big" data-action="save-settings">設定を保存</button>
  <div class="card form">
    <div class="card-head"><strong>データ</strong><span class="muted small">機種変更やバックアップに</span></div>
    <div class="btn-row">
      <button class="btn" data-action="export">書き出し（JSON）</button>
      <label class="btn">読み込み<input type="file" id="import-file" accept="application/json" hidden></label>
      <button class="btn danger" data-action="reset">すべて削除</button>
    </div>
  </div>
  <p class="muted small center">冷蔵庫コンシェルジュ v1.0 ・ 賞味期限は一般的な目安です。パッケージの表示を優先してください。</p>`;
}

// ---------- モーダル ----------
function openModal(html) {
  $("#modal-body").innerHTML = html;
  $("#modal").classList.remove("hidden");
}
function closeModal() {
  $("#modal").classList.add("hidden");
  $("#modal-body").innerHTML = "";
  UI.modalCtx = null;
  render();
}
function openItemEdit(id) {
  const it = S.items.find((i) => i.id === id);
  if (!it) return;
  UI.modalCtx = { kind: "item", draft: Object.assign({}, it) };
  renderItemModal();
}
function renderItemModal() {
  const d = UI.modalCtx.draft;
  openModal(`
  <div class="modal-head"><input class="title-input" data-bind="name" data-ctx="m" value="${esc(d.name)}"><button class="icon-btn" data-action="close-modal">✕</button></div>
  ${itemFormHTML(d, "m")}
  <div class="btn-row">
    <button class="btn primary big" data-action="save-item">保存</button>
    <button class="btn" data-action="cook-with" data-id="${d.id}">この食材でレシピ</button>
    <button class="btn danger" data-action="delete-item">削除</button>
  </div>`);
}
function ctxTarget(ctx) {
  if (ctx === "m") return UI.modalCtx && UI.modalCtx.draft;
  if (ctx && ctx.startsWith("d:")) return UI.drafts[Number(ctx.slice(2))];
  return null;
}
function rerenderCtx(ctx) {
  if (ctx === "m") renderItemModal(); else render();
}

// ---------- イベント ----------
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (!el || el.disabled) return;
  const a = el.dataset.action;
  const id = el.dataset.id;
  switch (a) {
    case "tab":
      UI.tab = el.dataset.tab; if (UI.tab !== "fridge") UI.selectMode = false;
      render(); window.scrollTo(0, 0); break;
    case "fridge-view": UI.fridgeView = el.dataset.v; render(); break;
    case "toggle-select-mode": UI.selectMode = !UI.selectMode; if (!UI.selectMode) UI.selected.clear(); render(); break;
    case "toggle-select":
      UI.selected.has(id) ? UI.selected.delete(id) : UI.selected.add(id); render(); break;
    case "clear-select": UI.selected.clear(); render(); break;
    case "go-recipe": UI.tab = "recipe"; UI.selectMode = false; UI.recipeQuery = ""; render(); window.scrollTo(0, 0); break;
    case "cook-with":
      UI.selected = new Set([id]); UI.recipeQuery = ""; UI.tab = "recipe"; UI.selectMode = false;
      if (!$("#modal").classList.contains("hidden")) closeModal(); else render();
      window.scrollTo(0, 0); break;
    case "edit-item": openItemEdit(id); break;
    case "set-field": {
      const ctx = el.dataset.ctx, t = ctxTarget(ctx);
      if (!t) break;
      t[el.dataset.field] = el.dataset.value;
      if (el.dataset.field === "storage") normalizeItem(t);
      rerenderCtx(ctx); break;
    }
    case "save-item": {
      const d = normalizeItem(UI.modalCtx.draft);
      d.name = d.name.trim() || "名前なし";
      const idx = S.items.findIndex((i) => i.id === d.id);
      if (idx >= 0) S.items[idx] = d;
      save(); toast("保存しました"); closeModal(); break;
    }
    case "delete-item": {
      const d = UI.modalCtx.draft;
      if (!confirmLike(`「${d.name}」を削除しますか？`)) break;
      S.items = S.items.filter((i) => i.id !== d.id); UI.selected.delete(d.id);
      save(); toast("削除しました"); closeModal(); break;
    }
    case "close-modal": closeModal(); break;
    case "reg-group": UI.regGroup = el.dataset.g; render(); break;
    case "toggle-draft": {
      const n = el.dataset.name;
      const i = UI.drafts.findIndex((d) => d.name === n);
      if (i >= 0) UI.drafts.splice(i, 1); else UI.drafts.push(normalizeItem(newItemFromName(n)));
      render(); break;
    }
    case "add-custom": {
      const n = $("#custom-name").value.trim();
      if (!n) { toast("名前を入れてください"); break; }
      UI.drafts.push(normalizeItem(newItemFromName(n, $("#custom-cat").value)));
      UI.regSearch = ""; render(); break;
    }
    case "remove-draft": UI.drafts.splice(Number(el.dataset.i), 1); render(); break;
    case "commit-drafts": {
      const n = UI.drafts.length;
      UI.drafts.forEach((d) => {
        const same = S.items.find((i) => i.name === d.name && i.storage === d.storage);
        if (same && same.qty === "0") Object.assign(same, d, { id: same.id }); // 買い足し
        else S.items.push(d);
      });
      UI.drafts = []; save(); toast(`${n}品を登録しました`);
      UI.tab = "fridge"; render(); window.scrollTo(0, 0); break;
    }
    case "open-recipe": {
      const r = recipeById(id);
      if (!r) { toast("レシピが見つかりません"); break; }
      openModal(recipeDetailHTML(r)); break;
    }
    case "save-ai": {
      const r = recipeById(id);
      if (r && !S.aiRecipes.some((x) => x.id === r.id)) { S.aiRecipes.push(r); S.aiRecipes = S.aiRecipes.slice(-100); save(); toast("レシピ集に保存しました"); }
      openModal(recipeDetailHTML(r)); break;
    }
    case "cook": { const r = recipeById(id); if (r) openModal(cookFormHTML(r)); break; }
    case "rate": {
      const n = Number(el.dataset.n); UI.modalCtx.rating = n;
      document.querySelectorAll("#rate .star").forEach((s, i) => s.classList.toggle("on", i < n)); break;
    }
    case "save-cook": saveCook(); break;
    case "rerate": {
      const h = S.history.find((x) => x.id === id);
      if (h) { h.rating = Number(el.dataset.n); updateLearningFor(h); save(); render(); }
      break;
    }
    case "del-history":
      if (!confirmLike("この記録を削除しますか？")) break;
      S.history = S.history.filter((h) => h.id !== id); rebuildLearning(); save(); render(); break;
    case "ai-recipes": askGeminiRecipes("normal"); break;
    case "ai-world": askGeminiRecipes("world"); break;
    case "extra-tab": UI.extraTab = el.dataset.t; render(); break;
    case "rq-date": $("#rq-date").value = el.dataset.v; break;
    case "add-request": {
      const dish = $("#rq-dish").value.trim();
      if (!dish) { toast("料理名を入れてください"); break; }
      S.requests.push({ id: uid(), who: $("#rq-who").value.trim(), dish, note: $("#rq-note").value.trim(), planned: $("#rq-date").value, done: false, created: today() });
      save(); toast("リクエストを受け付けました"); render(); break;
    }
    case "req-done": { const r = S.requests.find((x) => x.id === id); if (r) { r.done = !r.done; save(); render(); } break; }
    case "req-del": if (confirmLike("このリクエストを削除しますか？")) { S.requests = S.requests.filter((x) => x.id !== id); save(); render(); } break;
    case "req-recipe": UI.recipeQuery = el.dataset.dish; UI.selected.clear(); UI.tab = "recipe"; render(); window.scrollTo(0, 0); break;
    case "refresh-infos": refreshInfos(); break;
    case "add-info": {
      const title = $("#if-title").value.trim();
      if (!title) { toast("名前を入れてください"); break; }
      const url = $("#if-url").value.trim();
      S.infos.unshift({ id: uid(), kind: $("#if-kind").value, where: $("#if-where").value, title, desc: $("#if-desc").value.trim(), url: /^https?:\/\//.test(url) ? url : "", price: "", date: today(), auto: false });
      save(); render(); break;
    }
    case "del-info": S.infos = S.infos.filter((i) => i.id !== id); save(); render(); break;
    case "place-up": {
      const i = Number(el.dataset.i); if (i <= 0) break;
      [S.places[i - 1], S.places[i]] = [S.places[i], S.places[i - 1]]; save(); render(); break;
    }
    case "place-del": {
      const i = Number(el.dataset.i), p = S.places[i];
      const n = S.items.filter((x) => x.place === p).length;
      if (!confirmLike(`「${p}」を削除しますか？${n ? `（${n}品は「場所未設定」になります）` : ""}`)) break;
      S.places.splice(i, 1); save(); render(); break;
    }
    case "place-add": {
      const v = $("#new-place").value.trim();
      if (v && !S.places.includes(v)) { S.places.push(v); save(); render(); }
      break;
    }
    case "place-save": {
      document.querySelectorAll("[data-place]").forEach((inp) => {
        const i = Number(inp.dataset.place), oldName = S.places[i], nv = inp.value.trim();
        if (nv && nv !== oldName) { S.items.forEach((x) => { if (x.place === oldName) x.place = nv; }); S.places[i] = nv; }
      });
      save(); toast("場所を保存しました"); render(); break;
    }
    case "save-settings": {
      Object.assign(S.settings, {
        apiKey: $("#st-key").value.trim(), model: $("#st-model").value.trim() || "gemini-flash-latest",
        supermarket: $("#st-super").value.trim(), area: $("#st-area").value.trim(),
        tools: $("#st-tools").value.trim(), policy: $("#st-policy").value.trim(),
      });
      save(); toast("設定を保存しました"); break;
    }
    case "export": {
      const blob = new Blob([JSON.stringify(Object.assign({}, S, { settings: Object.assign({}, S.settings, { apiKey: "" }) }), null, 2)], { type: "application/json" });
      const a2 = document.createElement("a");
      a2.href = URL.createObjectURL(blob); a2.download = `fridge-concierge-${today()}.json`; a2.click();
      setTimeout(() => URL.revokeObjectURL(a2.href), 1000); break;
    }
    case "reset":
      if (confirmLike("すべてのデータを削除します。よろしいですか？")) { const key = S.settings.apiKey; S = defaultState(); S.settings.apiKey = key; save(); toast("削除しました"); render(); }
      break;
  }
});

// 入力欄の値をそのまま反映（再描画しない）
document.addEventListener("input", (e) => {
  const el = e.target;
  if (el.dataset.bind) {
    const t = ctxTarget(el.dataset.ctx);
    if (t) t[el.dataset.bind] = el.value;
  } else if (el.dataset.bindUi) {
    UI[el.dataset.bindUi] = el.value;
    if (el.dataset.bindUi === "regSearch") debounceRender(el);
    if (el.dataset.bindUi === "recipeQuery") debounceRender(el);
  }
});
document.addEventListener("change", (e) => {
  const el = e.target;
  if (el.dataset.bind && el.dataset.rerender) rerenderCtx(el.dataset.ctx);
  if (el.id === "import-file" && el.files[0]) importFile(el.files[0]);
});
let _rt;
function debounceRender(el) {
  clearTimeout(_rt);
  const key = el.dataset.bindUi;
  _rt = setTimeout(() => {
    render();
    const again = document.querySelector(`[data-bind-ui="${key}"]`);
    if (again) { again.focus(); const v = again.value; again.value = ""; again.value = v; }
  }, 350);
}
$("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });

// confirm() はタブレットのホーム画面アプリでも動くが、念のため関数にまとめる
function confirmLike(msg) { return window.confirm(msg); }

// ---------- 記録と学習 ----------
function saveCook() {
  const c = UI.modalCtx;
  const r = recipeById(c.recipeId);
  if (!c.rating) { toast("星で評価してください"); return; }
  const amounts = c.rows.map((row, i) => {
    const inp = document.querySelector(`[data-amt="${i}"]`);
    const used = inp ? Number(inp.value) : null;
    return { name: row.name, base: row.base, unit: row.unit, used: used == null || isNaN(used) ? null : used, seas: row.seas };
  });
  document.querySelectorAll("[data-used]").forEach((sel) => {
    const it = S.items.find((x) => x.id === sel.dataset.used);
    if (it) it.qty = sel.value;
  });
  if (r && r.ai && !S.aiRecipes.some((x) => x.id === r.id)) { S.aiRecipes.push(r); S.aiRecipes = S.aiRecipes.slice(-100); }
  const h = { id: uid(), date: today(), recipeId: c.recipeId, title: r ? r.t : "料理", country: r ? r.c : "", rating: c.rating, amounts, memo: ($("#cook-memo").value || "").trim() };
  S.history.push(h);
  rebuildLearning();
  save();
  $("#modal").classList.add("hidden"); UI.modalCtx = null;
  UI.selected.clear();
  toast("記録しました。次回の提案に反映します");
  render();
}
function updateLearningFor() { rebuildLearning(); }
function rebuildLearning() {
  // 記録から学習データを作り直す（直近の記録ほど重視するため最新20件まで）
  const rec = {}, glob = {};
  S.history.forEach((h) => {
    (h.amounts || []).forEach((a) => {
      if (!a.base || a.used == null || a.unit === "少々") return;
      const ratio = a.used / a.base;
      if (!isFinite(ratio) || ratio <= 0) return;
      const e = { ratio, rating: h.rating || 3 };
      rec[h.recipeId] = rec[h.recipeId] || {};
      (rec[h.recipeId][a.name] = rec[h.recipeId][a.name] || []).push(e);
      if (a.seas && (h.rating || 3) >= 3) {
        const gname = a.name.split("|")[0];
        (glob[gname] = glob[gname] || []).push(e);
      }
    });
  });
  Object.values(rec).forEach((o) => Object.keys(o).forEach((k) => { o[k] = o[k].slice(-20); }));
  Object.keys(glob).forEach((k) => { glob[k] = glob[k].slice(-20); });
  S.learn = { recipe: rec, global: glob };
}

function importFile(file) {
  const fr = new FileReader();
  fr.onload = () => {
    try {
      const d = JSON.parse(fr.result);
      if (!d || !Array.isArray(d.items)) throw new Error("形式が違います");
      const key = S.settings.apiKey;
      S = Object.assign(defaultState(), d);
      S.settings = Object.assign(defaultState().settings, d.settings || {}, { apiKey: key });
      save(); toast("読み込みました"); render();
    } catch (e) { toast("読み込めませんでした：" + e.message); }
  };
  fr.readAsText(file);
}

// ---------- 起動 ----------
render();
if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
