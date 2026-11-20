"use strict";

const $ = (id) => document.getElementById(id);
const state = { meta: null, campaigns: [], stream: null, rows: [], original: [], dirty: false, campaignId: "", streamId: "" };
const escapeHTML = (v) => String(v ?? "").replace(/[&<>"']/g, (ch) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[ch]));
const clone = (obj) => JSON.parse(JSON.stringify(obj));
const label = (o) => `${o.name || "Unnamed"} (#${o.id})`;

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch("/api" + path, {
      ...options,
      headers: {"Content-Type": "application/json", ...(options.headers || {})},
    });
  } catch (_) { throw new Error("Cannot reach Adrobot backend"); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data.detail;
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail || `HTTP ${response.status}`));
  }
  return data;
}

function alertMessage(message, error = false, html = false) {
  const n = $("notice");
  n.classList.remove("hidden");
  n.classList.toggle("error", error);
  if (html) n.innerHTML = message;
  else n.textContent = message;
  n.scrollIntoView({behavior:"smooth", block:"nearest"});
}
function optionFill(id, list, placeholder, selected) {
  const select = $(id);
  select.replaceChildren(new Option(placeholder, ""));
  (list || []).forEach((item) => select.add(new Option(label(item), String(item.id))));
  if (selected && Array.from(select.options).some((o) => o.value === String(selected))) select.value = String(selected);
}
function searchableOffers(searchId, selectId, predicate = () => true) {
  const q = $(searchId).value.trim().toLowerCase();
  const originalSelection = $(selectId).value;
  const matches = (state.meta?.offers || []).filter((o) =>
    o.state !== "deleted" && predicate(o) && (!q || label(o).toLowerCase().includes(q))
  );
  optionFill(selectId, matches, "Choose offer…", originalSelection);
}

async function loadMeta() {
  const info = await api("/meta");
  state.meta = info;
  optionFill("new-domain", info.domains.filter(o => o.state !== "deleted"), "Choose domain…");
  optionFill("new-group", info.groups, "Choose group…");
  optionFill("new-source", info.sources, "Choose traffic source…");
  searchableOffers("new-offer-search", "new-offer");
  searchableOffers("edit-offer-search", "edit-offer");
}
async function loadCampaigns() {
  state.campaigns = await api("/campaigns");
  optionFill("edit-campaign", state.campaigns.filter(x => x.state !== "deleted"), "Choose campaign…", $("edit-campaign").value);
}

async function loadStreams() {
  const id = Number($("edit-campaign").value);
  state.campaignId = $("edit-campaign").value;
  state.stream = null;
  $("editor-content").classList.add("hidden");
  $("edit-stream").disabled = true;
  optionFill("edit-stream", [], "Choose stream…");
  $("reload").disabled = true;
  $("stream-note").textContent = "Loading streams…";
  if (!id) { $("stream-note").textContent = "Choose a campaign to load offer streams"; return; }
  try {
    const streams = await api(`/campaigns/${id}/streams`);
    const available = streams.filter(s => s.schema === "landings" && s.state !== "deleted");
    optionFill("edit-stream", available, available.length ? "Choose stream…" : "No offer streams found");
    $("edit-stream").disabled = !available.length;
    $("stream-note").textContent = `${available.length} editable stream(s)`;
    if (available.length === 1) { $("edit-stream").value = String(available[0].id); await loadStream(); }
  } catch (e) { alertMessage(e.message, true); }
}

function rebalance() {
  const active = state.rows.filter(x => !x.removed);
  const locked = active.filter(x => x.locked);
  const unlocked = active.filter(x => !x.locked);
  const fixed = locked.reduce((sum, x) => sum + x.share, 0);
  if (fixed > 100) return;
  const remaining = 100 - fixed;
  if (!unlocked.length) return;
  const base = Math.floor(remaining / unlocked.length);
  let extra = remaining % unlocked.length;
  for (const row of unlocked) row.share = base + (extra-- > 0 ? 1 : 0);
}
function setDirty() { state.dirty = JSON.stringify(state.rows.map(x => ({id:x.id,share:x.share,removed:x.removed}))) !== JSON.stringify(state.original.map(x => ({id:x.id,share:x.share,removed:x.removed}))); }

function renderRows() {
  const root = $("offer-rows");
  root.replaceChildren();
  state.rows.forEach((row, idx) => {
    const container = document.createElement("div");
    container.className = "offer-row" + (row.removed ? " removed" : "");
    container.innerHTML = `
      <div><div class="offer-name">${escapeHTML(row.name)}</div><div class="offer-id">Offer ID ${row.id}</div></div>
      <div class="share-cell">
        ${row.removed ? '<span>0%</span>' : `<input class="share-value" data-id="${row.id}" type="number" min="0" max="100" step="1" value="${row.share}" aria-label="Share for offer ${row.id}"><span>%</span><button class="pin ${row.locked ? "pinned" : ""}" title="${row.locked ? "Unpin share" : "Pin share"}" data-pin="${row.id}">⚑</button>`}
      </div>
      <div><button class="mini ${row.removed ? "restore" : "danger"}" data-toggle="${row.id}">${row.removed ? "↶ Bring back" : "✕ Remove"}</button></div>`;
    root.append(container);
  });
  const active = state.rows.filter(x => !x.removed);
  const total = active.reduce((sum, x) => sum + x.share, 0);
  const valid = total === 100 && active.length > 0 && state.rows.every(x => Number.isInteger(x.share) && x.share >= 0 && x.share <= 100);
  const totalLabel = $("share-total");
  totalLabel.textContent = `Active offers: ${active.length} · Total: ${total}%`;
  totalLabel.classList.toggle("invalid", !valid);
  $("save").disabled = !valid || !state.dirty;
  $("cancel").disabled = !state.dirty;
  searchableOffers("edit-offer-search", "edit-offer", (x) => !state.rows.some(y => y.id === Number(x.id) && !y.removed));
}
async function loadStream() {
  const id = Number($("edit-stream").value);
  if (!id) { $("editor-content").classList.add("hidden"); return; }
  try {
    const data = await api(`/streams/${id}`);
    if (data.schema !== "landings") throw new Error("Selected stream is not an offer stream");
    state.stream = data;
    state.streamId = String(id);
    const offerMap = new Map((state.meta?.offers || []).map(o => [Number(o.id), o]));
    state.rows = (data.offers || []).map(o => {
      const ref = offerMap.get(Number(o.offer_id));
      return { id:Number(o.offer_id), name:ref?.name || `Offer #${o.offer_id}`,
        share:Number(o.share || 0), locked:false, removed:o.state !== "active" };
    });
    state.original = clone(state.rows);
    state.dirty = false;
    $("reload").disabled = false;
    $("stream-note").textContent = `Stream #${id} · ${data.name || "Untitled"}`;
    $("editor-content").classList.remove("hidden");
    renderRows();
  } catch (e) { alertMessage(e.message, true); }
}

async function initialize() {
  try {
    const health = await api("/health");
    $("connection").innerHTML = `<span class="dot"></span> ${health.keitaro_configured ? "Tracker configured" : "Configuration required"}`;
    $("connection").classList.toggle("ok", health.keitaro_configured);
    if (!health.keitaro_configured) { alertMessage("Add your Keitaro URL and API key to backend/.env, then restart the backend.", true); return; }
    await loadMeta();
    await loadCampaigns();
    $("connection").innerHTML = '<span class="dot"></span> Keitaro connected';
    $("connection").classList.add("ok");
  } catch (e) { alertMessage(e.message, true); $("connection").textContent = "Tracker unavailable"; }
}

document.querySelectorAll("[data-tab]").forEach(btn => btn.addEventListener("click", () => {
  if (state.dirty && btn.dataset.tab !== "edit" && !confirm("Discard unsaved offer changes?")) return;
  if (btn.dataset.tab !== "edit" && state.dirty) { state.rows = clone(state.original); state.dirty = false; }
  for (const tab of document.querySelectorAll("[data-tab]")) tab.classList.toggle("active", tab === btn);
  $("panel-create").classList.toggle("hidden", btn.dataset.tab !== "create");
  $("panel-edit").classList.toggle("hidden", btn.dataset.tab !== "edit");
  $("notice").classList.add("hidden");
}));
$("new-offer-search").addEventListener("input", () => searchableOffers("new-offer-search", "new-offer"));
$("edit-offer-search").addEventListener("input", () => searchableOffers("edit-offer-search", "edit-offer", o => !state.rows.some(x=>x.id===Number(o.id)&&!x.removed)));
$("create-form").addEventListener("submit", async e => {
  e.preventDefault();
  const geos = $("geo").value.split(/[\s,;]+/).filter(Boolean).map(x => x.toUpperCase());
  if (geos.some(x => !/^[A-Z]{2}$/.test(x))) { alertMessage("Use two-letter GEO codes, e.g. AU, MX, RO", true); return; }
  const body = {
    name:$("campaign-name").value, geos, offer_id:Number($("new-offer").value),
    domain_id:Number($("new-domain").value), group_id:Number($("new-group").value),
    traffic_source_id:Number($("new-source").value)
  };
  if (!confirm(`Create campaign "${body.name}" with ${geos.join(", ")} → Google, all others → offer #${body.offer_id}?`)) return;
  $("create-submit").disabled = true;
  try {
    const result = await api("/campaigns", {method:"POST", body:JSON.stringify(body)});
    const safeUrl = escapeHTML(result.url);
    alertMessage(`Campaign #${result.id} created. <a target="_blank" rel="noopener noreferrer" href="${safeUrl}">${safeUrl}</a> · ${result.streams.length} streams`, false, true);
    await loadCampaigns();
  } catch (e) { alertMessage(e.message, true); }
  finally { $("create-submit").disabled = false; }
});
$("edit-campaign").addEventListener("change", () => {
  if (state.dirty && !confirm("Discard unsaved changes?")) { $("edit-campaign").value = state.campaignId; return; }
  loadStreams();
});
$("edit-stream").addEventListener("change", () => {
  if (state.dirty && !confirm("Discard unsaved changes?")) { $("edit-stream").value = state.streamId; return; }
  loadStream();
});
$("reload").addEventListener("click", () => {
  if (state.dirty && !confirm("Discard unsaved changes and reload from Keitaro?")) return;
  loadStream();
});
$("offer-rows").addEventListener("click", (e) => {
  const toggle = e.target.closest("[data-toggle]");
  const pin = e.target.closest("[data-pin]");
  if (toggle) {
    const row = state.rows.find(x => x.id === Number(toggle.dataset.toggle));
    if (!row) return;
    row.removed = !row.removed;
    row.locked = false;
    row.share = 0;
    rebalance(); setDirty(); renderRows();
  }
  if (pin) {
    const row = state.rows.find(x => x.id === Number(pin.dataset.pin));
    if (!row) return;
    row.locked = !row.locked;
    rebalance(); setDirty(); renderRows();
  }
});
$("offer-rows").addEventListener("change", (e) => {
  const input = e.target.closest("[data-id]");
  if (!input) return;
  const row = state.rows.find(x => x.id === Number(input.dataset.id));
  if (!row) return;
  const number = Number(input.value);
  if (!Number.isInteger(number) || number < 0 || number > 100) {
    alertMessage("Shares must be whole percentages between 0 and 100", true); renderRows(); return;
  }
  const previous = row.share;
  row.share = number;
  row.locked = true;
  if (state.rows.filter(x => !x.removed && x.locked).reduce((sum,x)=>sum+x.share,0) > 100) {
    row.share = previous; alertMessage("Pinned shares cannot exceed 100%", true);
  }
  rebalance(); setDirty(); renderRows();
});
$("add-offer").addEventListener("click", () => {
  const id = Number($("edit-offer").value);
  if (!id) { alertMessage("Choose an offer", true); return; }
  const existing = state.rows.find(x => x.id === id);
  if (existing) { existing.removed = false; existing.locked = false; existing.share = 0; }
  else {
    const o = state.meta.offers.find(x => Number(x.id) === id);
    state.rows.push({id,name:o?.name || `Offer #${id}`,share:0,locked:false,removed:false});
  }
  rebalance(); setDirty(); renderRows();
  $("edit-offer-search").value = "";
});
$("cancel").addEventListener("click", () => { state.rows = clone(state.original); state.dirty = false; renderRows(); });
$("save").addEventListener("click", async () => {
  const streamId = state.stream?.id;
  const offers = state.rows.filter(o => !o.removed).map(o => ({offer_id:o.id,share:o.share,state:"active"}));
  if (!streamId || offers.reduce((s,x)=>s+x.share,0) !== 100) return;
  if (!confirm(`Push ${offers.length} active offer(s) to Keitaro stream #${streamId}?`)) return;
  $("save").disabled = true;
  try {
    await api(`/streams/${streamId}/offers`, {method:"PUT",body:JSON.stringify({offers})});
    await loadStream();
    alertMessage(`Stream #${streamId} updated in Keitaro. Values verified by read-back.`);
  } catch (e) { alertMessage(e.message, true); $("save").disabled = false; }
});
initialize();
