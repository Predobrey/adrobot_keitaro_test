"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  Activity, ArrowDownRight, ArrowRight, ArrowUpRight, Check, CheckCircle2,
  ChevronDown, CircleAlert, Copy, ExternalLink, Globe2, Layers3,
  LayoutDashboard, LockKeyhole, Plus, RefreshCcw, RotateCcw,
  Save, Search, ShieldCheck, SlidersHorizontal, Target, Trash2, X,
} from "lucide-react";
import { api, type Campaign, type CampaignPayload, type CreatedCampaign, type Meta, type MetaItem, type Stream } from "@/lib/api";
import { distribute, offersSignature, sharesValid, type OfferRow } from "@/lib/distribution";

type Page = "create" | "edit";
type Notice = { kind: "success" | "error" | "info"; message: string };
type Connection = "checking" | "ready" | "missing" | "error";

const blankForm = { name: "", geos: "", offerId: "", domainId: "", groupId: "", sourceId: "", offerSearch: "" };

function fieldLabel(id: string, children: ReactNode, hint?: string) {
  return <label className="field-label" htmlFor={id}>{children}{hint && <span className="field-hint">{hint}</span>}</label>;
}

function SelectField({ id, value, onChange, options, placeholder, disabled }: {
  id: string; value: string; onChange: (value: string) => void; options: MetaItem[];
  placeholder: string; disabled?: boolean;
}) {
  return (
    <div className="select-wrap">
      <select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} required>
        <option value="">{placeholder}</option>
        {options.map((item) => <option key={item.id} value={item.id}>{item.name} · #{item.id}</option>)}
      </select>
      <ChevronDown size={16} className="select-chevron" aria-hidden />
    </div>
  );
}

function setRowsFromStream(stream: Stream, offers: MetaItem[]): OfferRow[] {
  const names = new Map(offers.map((offer) => [Number(offer.id), offer.name]));
  return (stream.offers ?? []).map((offer) => ({
    id: Number(offer.offer_id), name: names.get(Number(offer.offer_id)) ?? `Offer #${offer.offer_id}`,
    share: Number(offer.share || 0), locked: false, removed: offer.state !== "active",
  }));
}

export default function Dashboard() {
  const [page, setPage] = useState<Page>("create");
  const [connection, setConnection] = useState<Connection>("checking");
  const [meta, setMeta] = useState<Meta | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [form, setForm] = useState(blankForm);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedCampaign | null>(null);
  const [campaignId, setCampaignId] = useState("");
  const [streamId, setStreamId] = useState("");
  const [availableStreams, setAvailableStreams] = useState<Stream[]>([]);
  const [stream, setStream] = useState<Stream | null>(null);
  const [rows, setRows] = useState<OfferRow[]>([]);
  const [baseline, setBaseline] = useState<OfferRow[]>([]);
  const [editorBusy, setEditorBusy] = useState(false);
  const [offerSearch, setOfferSearch] = useState("");
  const [addOfferId, setAddOfferId] = useState("");
  const requestRef = useRef(0);

  const ready = connection === "ready";
  const dirty = offersSignature(rows) !== offersSignature(baseline);
  const valid = sharesValid(rows);
  const activeRows = rows.filter((row) => !row.removed);
  const sum = activeRows.reduce((total, row) => total + row.share, 0);
  const activeOffers = useMemo(() => (meta?.offers ?? []).filter((item) => item.state === undefined || item.state === "active"), [meta]);
  const filteredCreateOffers = useMemo(() => activeOffers.filter((item) => `${item.name} ${item.id}`.toLowerCase().includes(form.offerSearch.toLowerCase())), [activeOffers, form.offerSearch]);
  const filteredEditOffers = useMemo(() => activeOffers.filter((item) =>
    `${item.name} ${item.id}`.toLowerCase().includes(offerSearch.toLowerCase()) &&
    !rows.some((row) => row.id === Number(item.id) && !row.removed)), [activeOffers, offerSearch, rows]);

  useEffect(() => {
    let cancelled = false;
    async function bootstrap() {
      try {
        const health = await api<{ status: string; keitaro_configured: boolean }>("/health");
        if (cancelled) return;
        if (!health.keitaro_configured) {
          setConnection("missing");
          setNotice({ kind: "error", message: "Add KEITARO_BASE_URL and KEITARO_API_KEY to backend/.env, then restart FastAPI." });
          return;
        }
        const [info, campaignList] = await Promise.all([api<Meta>("/meta"), api<Campaign[]>("/campaigns")]);
        if (cancelled) return;
        setMeta(info);
        setCampaigns(campaignList);
        setConnection("ready");
      } catch (error) {
        if (cancelled) return;
        setConnection("error");
        setNotice({ kind: "error", message: getMessage(error) });
      }
    }
    void bootstrap();
    return () => { cancelled = true; };
  }, []);

  function patchForm(key: keyof typeof blankForm, value: string) {
    setForm((old) => ({ ...old, [key]: value }));
  }
  function warnUnsaved(): boolean {
    return !dirty || window.confirm("Discard unsaved offer changes?");
  }
  function navigate(next: Page) {
    if (next === page || !warnUnsaved()) return;
    if (dirty) setRows(baseline.map((row) => ({ ...row })));
    setPage(next);
    setNotice(null);
  }
  async function refreshCampaigns() {
    const list = await api<Campaign[]>("/campaigns");
    setCampaigns(list);
  }

  async function submitCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice(null);
    setCreated(null);
    const geos = [...new Set(form.geos.toUpperCase().split(/[,;\s]+/).filter(Boolean))];
    if (geos.length < 1 || geos.some((value) => !/^[A-Z]{2}$/.test(value))) {
      setNotice({ kind: "error", message: "Use ISO-2 country codes, for example AU, MX, RO." });
      return;
    }
    const payload: CampaignPayload = {
      name: form.name.trim(), geos, offer_id: Number(form.offerId), domain_id: Number(form.domainId),
      group_id: Number(form.groupId), traffic_source_id: Number(form.sourceId),
    };
    if (!payload.name || !payload.offer_id || !payload.domain_id || !payload.group_id || !payload.traffic_source_id) {
      setNotice({ kind: "error", message: "Fill in all campaign fields before creating it." });
      return;
    }
    if (!window.confirm(`Create “${payload.name}”? ${geos.join(", ")} → Google; all other countries → offer #${payload.offer_id}. This will write to Keitaro.`)) return;
    setCreating(true);
    try {
      const result = await api<CreatedCampaign>("/campaigns", { method: "POST", body: JSON.stringify(payload) });
      setCreated(result);
      setNotice({ kind: "success", message: `Campaign #${result.id} created in Keitaro with ${result.streams.length} streams.` });
      await refreshCampaigns();
    } catch (error) {
      setNotice({ kind: "error", message: getMessage(error) });
    } finally {
      setCreating(false);
    }
  }

  async function chooseCampaign(id: string) {
    if (!warnUnsaved()) return;
    const request = ++requestRef.current;
    setCampaignId(id);
    setStreamId("");
    setStream(null);
    setRows([]);
    setBaseline([]);
    setAvailableStreams([]);
    setOfferSearch("");
    setAddOfferId("");
    setNotice(null);
    if (!id) return;
    setEditorBusy(true);
    try {
      const streams = await api<Stream[]>(`/campaigns/${Number(id)}/streams`);
      if (request !== requestRef.current) return;
      const editable = streams.filter((item) => item.schema === "landings" && item.state !== "deleted");
      setAvailableStreams(editable);
      if (editable.length === 1) await loadStream(editable[0].id, request);
    } catch (error) {
      if (request === requestRef.current) setNotice({ kind: "error", message: getMessage(error) });
    } finally {
      if (request === requestRef.current) setEditorBusy(false);
    }
  }

  async function loadStream(id: number, request: number) {
    const value = await api<Stream>(`/streams/${id}`);
    if (request !== requestRef.current) return;
    if (value.schema !== "landings") throw new Error("This is not an offer stream.");
    const incoming = setRowsFromStream(value, meta?.offers ?? []);
    setStreamId(String(id));
    setStream(value);
    setRows(incoming);
    setBaseline(incoming.map((row) => ({ ...row })));
    setOfferSearch("");
    setAddOfferId("");
  }

  async function chooseStream(id: string) {
    if (!warnUnsaved()) return;
    const request = ++requestRef.current;
    setStreamId(id);
    setStream(null);
    setRows([]);
    setBaseline([]);
    setNotice(null);
    if (!id) return;
    setEditorBusy(true);
    try {
      await loadStream(Number(id), request);
    } catch (error) {
      if (request === requestRef.current) setNotice({ kind: "error", message: getMessage(error) });
    } finally {
      if (request === requestRef.current) setEditorBusy(false);
    }
  }

  async function reloadStream() {
    if (!streamId || !warnUnsaved()) return;
    const request = ++requestRef.current;
    setEditorBusy(true);
    setNotice(null);
    try {
      await loadStream(Number(streamId), request);
    } catch (error) {
      if (request === requestRef.current) setNotice({ kind: "error", message: getMessage(error) });
    } finally {
      if (request === requestRef.current) setEditorBusy(false);
    }
  }

  function updateShare(id: number, text: string) {
    if (!/^\d+$/.test(text)) return;
    const value = Number(text);
    if (!Number.isInteger(value) || value < 0 || value > 100) return;
    const proposed = rows.map((row) => row.id === id ? { ...row, share: value, locked: true } : { ...row });
    if (proposed.filter((row) => !row.removed && row.locked).reduce((total, row) => total + row.share, 0) > 100) {
      setNotice({ kind: "error", message: "Pinned shares cannot exceed 100%." });
      return;
    }
    setRows(distribute(proposed));
    setNotice(null);
  }
  function togglePin(id: number) {
    setRows((previous) => distribute(previous.map((row) => row.id === id ? { ...row, locked: !row.locked } : row)));
  }
  function toggleRemoved(id: number) {
    if (activeRows.length === 1 && activeRows[0].id === id) {
      setNotice({ kind: "error", message: "At least one active offer is required." });
      return;
    }
    setRows((previous) => distribute(previous.map((row) => row.id === id
      ? { ...row, removed: !row.removed, locked: false, share: 0 } : row)));
    setNotice(null);
  }
  function addOffer() {
    const id = Number(addOfferId);
    const item = activeOffers.find((offer) => Number(offer.id) === id);
    if (!item) {
      setNotice({ kind: "error", message: "Choose an available offer from Keitaro." });
      return;
    }
    if (rows.some((row) => row.id === id && !row.removed)) return;
    const exists = rows.some((row) => row.id === id);
    const proposed = exists ? rows.map((row) => row.id === id ? { ...row, removed: false, share: 0, locked: false } : row)
      : [...rows, { id, name: item.name, share: 0, locked: false, removed: false }];
    setRows(distribute(proposed));
    setAddOfferId("");
    setOfferSearch("");
    setNotice(null);
  }
  async function saveOffers() {
    if (!streamId || !dirty || !valid || editorBusy) return;
    const payload = rows.filter((row) => !row.removed)
      .map((row) => ({ offer_id: row.id, share: row.share, state: "active" }));
    if (!window.confirm(`Push ${payload.length} active offer(s) to Keitaro stream #${streamId}?`)) return;
    const request = ++requestRef.current;
    setEditorBusy(true);
    setNotice(null);
    try {
      await api(`/streams/${Number(streamId)}/offers`, { method: "PUT", body: JSON.stringify({ offers: payload }) });
      await loadStream(Number(streamId), request);
      setNotice({ kind: "success", message: `Stream #${streamId} saved and verified with Keitaro.` });
    } catch (error) {
      setNotice({ kind: "error", message: getMessage(error) });
    } finally {
      if (request === requestRef.current) setEditorBusy(false);
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark"><Layers3 size={22} strokeWidth={2.4} /></span>
          <span><strong>adrobot<span className="brand-period">.</span></strong><small>KEITARO WORKSPACE</small></span>
        </div>
        <p className="side-caption">WORKSPACE</p>
        <nav className="side-nav" aria-label="Workspace navigation">
          <button className={page === "create" ? "nav-item active" : "nav-item"} onClick={() => navigate("create")}><Plus size={18} /> Create campaign {page === "create" && <span className="nav-active-dot" />}</button>
          <button className={page === "edit" ? "nav-item active" : "nav-item"} onClick={() => navigate("edit")}><SlidersHorizontal size={18} /> Offer editor {page === "edit" && <span className="nav-active-dot" />}</button>
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-info"><ShieldCheck size={17} /><span>Secure API connection<small>Credentials stay on FastAPI</small></span></div>
          <div className="sidebar-footer">Adrobot <span>·</span> Assignment workspace</div>
        </div>
      </aside>

      <div className="main-layout">
        <header className="topbar">
          <div className="breadcrumbs"><LayoutDashboard size={16} /><span>Workspace</span><span className="slash">/</span><strong>{page === "create" ? "Create campaign" : "Offer editor"}</strong></div>
          <div className={`connection ${connection}`}><span className="status-dot" />{connection === "ready" ? "Keitaro connected" : connection === "checking" ? "Checking connection" : connection === "missing" ? "Setup required" : "Tracker unavailable"}</div>
        </header>
        <main className="main-content">
          <div className="page-heading">
            <div><span className="eyebrow"><span className="eyebrow-line" /> CAMPAIGN OPERATIONS</span><h1>{page === "create" ? "Create campaign" : "Offer distribution"}<span className="heading-period">.</span></h1><p>{page === "create" ? "Build a Keitaro campaign with geo-based routing in one place." : "Manage offers and traffic weights in an existing Keitaro stream."}</p></div>
            <div className="version-chip"><Activity size={15} /> Keitaro Admin API</div>
          </div>

          {notice && <div className={`notice ${notice.kind}`} role="alert"><span>{notice.kind === "success" ? <CheckCircle2 size={20} /> : <CircleAlert size={20} />}</span><p>{notice.message}</p><button aria-label="Dismiss notification" onClick={() => setNotice(null)}><X size={17} /></button></div>}

          {page === "create" ? (
            <div className="workspace-grid">
              <section className="panel form-panel">
                <div className="panel-heading"><div className="panel-heading-icon"><Target size={20} /></div><div><h2>Campaign details</h2><p>Configure the campaign and select its target offer.</p></div><span className="section-index">01</span></div>
                <form onSubmit={(event) => void submitCreate(event)} className="form-grid">
                  <div className="field full">{fieldLabel("campaign-name", "Campaign name")}<input id="campaign-name" required maxLength={200} value={form.name} onChange={(e) => patchForm("name", e.target.value)} placeholder="e.g. AU — Summer Campaign" disabled={!ready || creating} /></div>
                  <div className="field full">{fieldLabel("geos", "GEO targeting", "ISO 3166-1 alpha-2")}<div className="field-icon"><Globe2 size={17} /><input id="geos" required value={form.geos} onChange={(e) => patchForm("geos", e.target.value)} placeholder="AU, MX, RO" disabled={!ready || creating} /></div><small>Visitors from these countries will be redirected to Google.</small></div>
                  <div className="field full">{fieldLabel("create-offer-search", "Keitaro offer", "Find by ID or name")}<div className="field-icon"><Search size={17} /><input id="create-offer-search" value={form.offerSearch} onChange={(e) => patchForm("offerSearch", e.target.value)} placeholder="Search offers..." disabled={!ready || creating} /></div><SelectField id="create-offer" value={form.offerId} onChange={(value) => patchForm("offerId", value)} options={filteredCreateOffers.some((x) => String(x.id) === form.offerId) ? filteredCreateOffers : [...filteredCreateOffers, ...activeOffers.filter((x) => String(x.id) === form.offerId)]} placeholder="Select an offer" disabled={!ready || creating} /></div>
                  <div className="form-separator"><span>TRAFFIC SETTINGS</span></div>
                  <div className="field">{fieldLabel("domain", "Domain")}<SelectField id="domain" value={form.domainId} onChange={(value) => patchForm("domainId", value)} options={meta?.domains ?? []} placeholder="Choose domain" disabled={!ready || creating} /></div>
                  <div className="field">{fieldLabel("group", "Campaign group")}<SelectField id="group" value={form.groupId} onChange={(value) => patchForm("groupId", value)} options={meta?.groups ?? []} placeholder="Choose group" disabled={!ready || creating} /></div>
                  <div className="field full">{fieldLabel("source", "Traffic source")}<SelectField id="source" value={form.sourceId} onChange={(value) => patchForm("sourceId", value)} options={meta?.sources ?? []} placeholder="Choose traffic source" disabled={!ready || creating} /></div>
                  <div className="form-actions"><span><LockKeyhole size={15} /> Writes only after confirmation</span><button className="btn primary" disabled={!ready || creating} type="submit">{creating ? "Creating…" : "Create campaign"}<ArrowRight size={17} /></button></div>
                </form>
              </section>
              <div className="right-stack">
                <section className="panel routing-panel"><div className="aside-heading"><span className="eyebrow">ROUTING PREVIEW</span><span className="live-chip"><span /> 2 STREAMS</span></div><h2>Smart traffic routing</h2><p className="aside-lead">Traffic is distributed automatically based on the visitor&apos;s country.</p><div className="flow-start"><Globe2 size={20} /><div><strong>Incoming visitor</strong><small>Keitaro tracking link</small></div></div><div className="flow-line" /><div className="flow-card google"><div className="flow-symbol">G</div><div><span className="flow-label">FLOW 01 · FORCED</span><strong>Google redirect</strong><small>{form.geos.trim() ? form.geos.toUpperCase().split(/[,;\s]+/).filter(Boolean).join(" · ") : "Matching GEO countries"}</small></div><ArrowUpRight size={18} /></div><div className="flow-connector"><span>OTHER TRAFFIC</span><ArrowDownRight size={17} /></div><div className="flow-card offer"><div className="flow-symbol"><Target size={19} /></div><div><span className="flow-label">FLOW 02 · DEFAULT</span><strong>Selected offer</strong><small>{form.offerId ? `Offer ID #${form.offerId}` : "All other countries"}</small></div><ArrowUpRight size={18} /></div><div className="routing-foot"><CheckCircle2 size={16} /><span>Position-based stream priority</span></div></section>
                <div className="tip-card"><div className="tip-icon"><ShieldCheck size={20} /></div><div><strong>Safe by design</strong><p>API keys remain in the FastAPI backend. Every creation requires your approval.</p></div></div>
                {created && <section className="panel created-card"><span className="eyebrow">CREATED IN KEITARO</span><h3>{created.name} · #{created.id}</h3><a href={created.url} target="_blank" rel="noopener noreferrer">Open campaign link <ExternalLink size={15} /></a><button className="text-button" onClick={() => void navigator.clipboard.writeText(created.url)}><Copy size={15} /> Copy URL</button></section>}
              </div>
            </div>
          ) : (
            <div className="workspace-grid">
              <section className="panel editor-panel">
                <div className="panel-heading"><div className="panel-heading-icon"><SlidersHorizontal size={20} /></div><div><h2>Stream offer editor</h2><p>Select a campaign, then adjust its offer distribution.</p></div><span className="section-index">02</span></div>
                <div className="editor-pickers"><div className="field">{fieldLabel("campaign", "Campaign")}<div className="select-wrap"><select id="campaign" value={campaignId} disabled={!ready || editorBusy} onChange={(e) => void chooseCampaign(e.target.value)}><option value="">Choose campaign</option>{campaigns.map((item) => <option key={item.id} value={item.id}>{item.name} · #{item.id}</option>)}</select><ChevronDown size={16} className="select-chevron" /></div></div><div className="field">{fieldLabel("stream", "Offer stream")}<div className="select-wrap"><select id="stream" value={streamId} disabled={!campaignId || editorBusy || !availableStreams.length} onChange={(e) => void chooseStream(e.target.value)}><option value="">Choose stream</option>{availableStreams.map((item) => <option key={item.id} value={item.id}>{item.name} · #{item.id}</option>)}</select><ChevronDown size={16} className="select-chevron" /></div></div></div>
                <div className="editor-toolbar"><span><span className="toolbar-dot" />{stream ? `Stream #${stream.id} · ${stream.name}` : editorBusy ? "Loading Keitaro data…" : campaignId && !availableStreams.length ? "No editable offer streams" : "Choose a campaign to get started"}</span><button className="btn outline small" onClick={() => void reloadStream()} disabled={!stream || editorBusy}><RefreshCcw size={15} /> Refresh</button></div>
                {!stream ? <div className="empty-state"><div className="empty-illustration"><Layers3 size={34} /></div><h3>No stream selected</h3><p>Select an existing campaign and its offer stream to edit the offer shares.</p></div> : <>
                  <div className="offer-table-head"><span>OFFER</span><span>TRAFFIC SHARE</span><span>ACTION</span></div>
                  <div className="offer-list">{rows.map((row) => <div className={`offer-row ${row.removed ? "removed" : ""}`} key={row.id}><div className="offer-name"><span className="offer-avatar"><Target size={17} /></span><div><strong>{row.name}</strong><small>Offer #{row.id}</small></div></div><div className="share-group">{row.removed ? <span className="removed-label">0% · Removed</span> : <><div className="share-input"><input type="number" aria-label={`Share for offer ${row.id}`} min="0" max="100" step="1" value={row.share} disabled={editorBusy} onChange={(e) => updateShare(row.id, e.target.value)} /><span>%</span></div><button className={`icon-btn ${row.locked ? "locked" : ""}`} title={row.locked ? "Unpin share" : "Pin share"} aria-label={row.locked ? `Unpin offer ${row.id}` : `Pin offer ${row.id}`} disabled={editorBusy} onClick={() => togglePin(row.id)}><LockKeyhole size={16} /></button></>}</div><div className="offer-action"><button className={`btn ${row.removed ? "outline restore" : "danger-ghost"} small`} disabled={editorBusy} onClick={() => toggleRemoved(row.id)}>{row.removed ? <><RotateCcw size={15} /> Bring back</> : <><Trash2 size={15} /> Remove</>}</button></div></div>)}</div>
                  <div className="add-section"><div className="add-heading"><Plus size={17} /><strong>Add an offer</strong></div><div className="add-grid"><div className="field-icon"><Search size={16} /><input aria-label="Search offers to add" value={offerSearch} onChange={(e) => setOfferSearch(e.target.value)} placeholder="Search by name or ID" disabled={editorBusy} /></div><div className="select-wrap"><select aria-label="Offer to add" value={addOfferId} disabled={editorBusy} onChange={(e) => setAddOfferId(e.target.value)}><option value="">Select an offer</option>{(filteredEditOffers.some((x) => String(x.id) === addOfferId) ? filteredEditOffers : [...filteredEditOffers, ...activeOffers.filter((x) => String(x.id) === addOfferId)]).map((item) => <option key={item.id} value={item.id}>{item.name} · #{item.id}</option>)}</select><ChevronDown size={16} className="select-chevron" /></div><button className="btn outline" onClick={addOffer} disabled={!addOfferId || editorBusy}><Plus size={17} /> Add</button></div></div>
                  <div className="editor-footer"><div className={`total ${valid ? "" : "invalid"}`}><span>Total distribution</span><strong>{sum}% <span>/ 100%</span></strong></div><div className="editor-buttons"><button className="btn outline" disabled={!dirty || editorBusy} onClick={() => { setRows(baseline.map((row) => ({ ...row }))); setNotice(null); }}><X size={16} /> Cancel</button><button className="btn primary" disabled={!dirty || !valid || editorBusy} onClick={() => void saveOffers()}><Save size={17} /> {editorBusy ? "Saving…" : "Push to Keitaro"}</button></div></div>
                </>}
              </section>
              <div className="right-stack"><section className="panel summary-panel"><span className="eyebrow">STREAM OVERVIEW</span><h2>Distribution summary</h2><p className="aside-lead">Review the active offer mix before pushing changes.</p><div className="summary-stat"><span>Active offers</span><strong>{activeRows.length}</strong></div><div className="summary-stat"><span>Assigned traffic</span><strong className={valid ? "good" : "bad"}>{sum}%</strong></div><div className="summary-stat"><span>Unsaved changes</span><strong>{dirty ? "Yes" : "No"}</strong></div><div className="share-bar" aria-label={`Allocated traffic ${sum}%`}><span style={{ width: `${Math.min(sum, 100)}%` }} /></div><div className="summary-tip"><CircleAlert size={16} /><p>Changes stay local until you select <strong>Push to Keitaro</strong>. Saving reloads the stream to verify the result.</p></div></section><div className="tip-card"><div className="tip-icon"><Check size={20} /></div><div><strong>Precise shares</strong><p>Unpinned offers split the remaining percentage with no rounding drift.</p></div></div></div>
            </div>
          )}
          <footer className="page-footer"><span>© Adrobot · Keitaro Campaign Manager</span><span>Local workspace <span className="footer-separator">·</span> No background writes</span></footer>
        </main>
      </div>
    </div>
  );
}

function getMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unexpected error. Please try again.";
}
