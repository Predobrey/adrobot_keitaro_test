"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  Activity, ArrowDownRight, ArrowRight, ArrowUpRight, Check, CheckCircle2,
  ChevronDown, CircleAlert, Copy, ExternalLink, Globe2, Layers3,
  LayoutDashboard, LockKeyhole, Plus, RefreshCcw, RotateCcw,
  Save, Search, ShieldCheck, SlidersHorizontal, Target, Trash2, X,
} from "lucide-react";
import { api, type Campaign, type CampaignPayload, type CreatedCampaign, type Meta, type MetaItem, type Stream } from "@/lib/api";
import { offersSignature, sharesValid, type OfferRow } from "@/lib/distribution";
import { appendOffer, buildOffersPayload, changeShare, parseShareInput, readStoredPins, reconcileLoadedOffers, resetEditor, restoreSessionPins, switchPin, switchRemoved, writeStoredPins } from "@/lib/editor";

type Page = "create" | "edit";
type Notice = { kind: "success" | "error" | "info"; message: string };
type Connection = "checking" | "ready" | "missing" | "error";

const KEITARO_EMULATOR_ADMIN_URL = "https://keitaro-for-tests.etolegko.com/admin/";

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
    id: Number(offer.offer_id), name: names.get(Number(offer.offer_id)) ?? `Оффер №${offer.offer_id}`,
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
  const [emptyShareIds, setEmptyShareIds] = useState<number[]>([]);
  const [baseline, setBaseline] = useState<OfferRow[]>([]);
  const [editorBusy, setEditorBusy] = useState(false);
  const [offerSearch, setOfferSearch] = useState("");
  const [addOfferId, setAddOfferId] = useState("");
  const requestRef = useRef(0);
  // Stream-scoped, in-memory history. It intentionally does not persist locally
  // or create another source of truth beside Keitaro.
  const knownRowsRef = useRef<Map<number, OfferRow[]>>(new Map());
  // Editor-only preferences: kept in memory and mirrored to localStorage so
  // pins survive F5/browser restarts without changing Keitaro or SQLite.
  const pinnedByStreamRef = useRef<Map<number, Set<number>>>(new Map());

  function storedPinsForStream(id: number): Set<number> {
    const inMemory = pinnedByStreamRef.current.get(id);
    if (inMemory) return inMemory;
    try {
      return readStoredPins(window.localStorage, id);
    } catch {
      return new Set<number>();
    }
  }
  function rememberPinsForStream(id: number, nextRows: OfferRow[]) {
    if (!Number.isSafeInteger(id) || id <= 0) return;
    const pins = new Set(nextRows
      .filter((row) => row.locked && !row.removed).map((row) => row.id));
    pinnedByStreamRef.current.set(id, pins);
    try {
      writeStoredPins(window.localStorage, id, pins);
    } catch {
      // localStorage may be disabled; pins still work in the current tab.
    }
  }
  function rememberCurrentPins(nextRows: OfferRow[]) {
    if (streamId) rememberPinsForStream(Number(streamId), nextRows);
  }
  function discardEditorChanges() {
    if (!dirty) return;
    const restored = resetEditor(baseline);
    rememberCurrentPins(restored);
    setRows(restored);
    setEmptyShareIds([]);
  }

  const ready = connection === "ready";
  const dirty = offersSignature(rows) !== offersSignature(baseline) || emptyShareIds.length > 0;
  const valid = sharesValid(rows) && emptyShareIds.length === 0;
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
          setNotice({ kind: "error", message: "Укажите KEITARO_BASE_URL и KEITARO_API_KEY в backend/.env и перезапустите FastAPI." });
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
    return !dirty || window.confirm("Отменить несохранённые изменения офферов?");
  }
  function navigate(next: Page) {
    if (next === page || !warnUnsaved()) return;
    discardEditorChanges();
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
      setNotice({ kind: "error", message: "Укажите двухбуквенные коды стран ISO 3166-1, например AU, MX, RO." });
      return;
    }
    const payload: CampaignPayload = {
      name: form.name.trim(), geos, offer_id: Number(form.offerId), domain_id: Number(form.domainId),
      group_id: Number(form.groupId), traffic_source_id: Number(form.sourceId),
    };
    if (!payload.name || !payload.offer_id || !payload.domain_id || !payload.group_id || !payload.traffic_source_id) {
      setNotice({ kind: "error", message: "Заполните все поля кампании перед созданием." });
      return;
    }
    if (!window.confirm(`Создать кампанию «${payload.name}»? Страны ${geos.join(", ")} → Google, остальные страны → оффер №${payload.offer_id}. Данные будут записаны в Keitaro.`)) return;
    setCreating(true);
    try {
      const result = await api<CreatedCampaign>("/campaigns", { method: "POST", body: JSON.stringify(payload) });
      setCreated(result);
      setNotice({ kind: "success", message: `Кампания №${result.id} создана в Keitaro. Потоков: ${result.streams.length}.` });
      try {
        await refreshCampaigns();
      } catch {
        // The campaign was already created: a list-refresh failure is not a failed write.
        setNotice({ kind: "info", message: `Кампания №${result.id} создана в Keitaro, но не удалось обновить список кампаний. Обновите страницу позже.` });
      }
    } catch (error) {
      setNotice({ kind: "error", message: getMessage(error) });
    } finally {
      setCreating(false);
    }
  }

  async function chooseCampaign(id: string) {
    if (!warnUnsaved()) return;
    discardEditorChanges();
    const request = ++requestRef.current;
    setCampaignId(id);
    setStreamId("");
    setStream(null);
    setRows([]);
    setEmptyShareIds([]);
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
    if (value.schema !== "landings") throw new Error("Выбранный поток не поддерживает редактирование офферов.");
    const incoming = restoreSessionPins(
      reconcileLoadedOffers(
        knownRowsRef.current.get(id) ?? [],
        setRowsFromStream(value, meta?.offers ?? []),
      ),
      storedPinsForStream(id),
    );
    // A removed offer cannot keep a pin; Keitaro remains the source of truth
    // for which offers are active and for all percentages.
    rememberPinsForStream(id, incoming);
    knownRowsRef.current.set(id, incoming.map((row) => ({ ...row })));
    setStreamId(String(id));
    setStream(value);
    setRows(incoming);
    setEmptyShareIds([]);
    setBaseline(incoming.map((row) => ({ ...row })));
    setOfferSearch("");
    setAddOfferId("");
  }

  async function chooseStream(id: string) {
    if (!warnUnsaved()) return;
    discardEditorChanges();
    const request = ++requestRef.current;
    setStreamId(id);
    setStream(null);
    setRows([]);
    setEmptyShareIds([]);
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
    // A confirmed refresh discards unsaved share edits, not saved server data.
    if (dirty) rememberCurrentPins(baseline);
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
    try {
      const value = parseShareInput(text);
      if (value === null) {
        // Allow clearing a controlled input before typing the replacement.
        // This draft cannot be saved until a valid percentage is entered.
        setEmptyShareIds((current) => current.includes(id) ? current : [...current, id]);
      } else {
        const next = changeShare(rows, id, value);
        setRows(next);
        rememberCurrentPins(next);
        setEmptyShareIds((current) => current.filter((item) => item !== id));
      }
      setNotice(null);
    } catch (error) {
      setNotice({ kind: "error", message: getMessage(error) });
    }
  }
  function togglePin(id: number) {
    const next = switchPin(rows, id);
    setRows(next);
    rememberCurrentPins(next);
  }
  function toggleRemoved(id: number) {
    try {
      const next = switchRemoved(rows, id);
      setRows(next);
      rememberCurrentPins(next);
      setEmptyShareIds((current) => current.filter((item) => item !== id));
      setNotice(null);
    } catch (error) {
      setNotice({ kind: "error", message: getMessage(error) });
    }
  }
  function addOffer() {
    const id = Number(addOfferId);
    const item = activeOffers.find((offer) => Number(offer.id) === id);
    if (!item) {
      setNotice({ kind: "error", message: "Выберите доступный оффер из Keitaro." });
      return;
    }
    try {
      const next = appendOffer(rows, { id, name: item.name });
      setRows(next);
      rememberCurrentPins(next);
      setAddOfferId("");
      setOfferSearch("");
      setNotice(null);
    } catch (error) {
      setNotice({ kind: "error", message: getMessage(error) });
    }
  }
  async function saveOffers() {
    if (!streamId || !dirty || !valid || editorBusy) return;
    const payload = buildOffersPayload(rows);
    if (!window.confirm(`Сохранить в Keitaro ${payload.length} активных офферов для потока №${streamId}?`)) return;
    const request = ++requestRef.current;
    setEditorBusy(true);
    setNotice(null);
    try {
      await api(`/streams/${Number(streamId)}/offers`, { method: "PUT", body: JSON.stringify({ offers: payload }) });
      // A successful PUT establishes the newly seen IDs, even if the follow-up
      // GET temporarily fails. The API read-back will still override their status.
      knownRowsRef.current.set(Number(streamId), rows.map((row) => ({ ...row })));
      await loadStream(Number(streamId), request);
      setNotice({ kind: "success", message: `Поток №${streamId} сохранён. Данные повторно проверены в Keitaro.` });
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
          <span><strong>adrobot<span className="brand-period">.</span></strong><small>ПАНЕЛЬ KEITARO</small></span>
        </div>
        <p className="side-caption">РАБОЧАЯ ОБЛАСТЬ</p>
        <nav className="side-nav" aria-label="Навигация по Adrobot">
          <button className={page === "create" ? "nav-item active" : "nav-item"} onClick={() => navigate("create")}><Plus size={18} /> Создать кампанию {page === "create" && <span className="nav-active-dot" />}</button>
          <button className={page === "edit" ? "nav-item active" : "nav-item"} onClick={() => navigate("edit")}><SlidersHorizontal size={18} /> Редактор офферов {page === "edit" && <span className="nav-active-dot" />}</button>
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-info"><ShieldCheck size={17} /><span>Защищённое API-подключение<small>Ключ хранится на стороне FastAPI</small></span></div>
          <div className="sidebar-footer">Adrobot <span>·</span> Тестовое задание</div>
        </div>
      </aside>

      <div className="main-layout">
        <header className="topbar">
          <div className="breadcrumbs"><LayoutDashboard size={16} /><span>Панель управления</span><span className="slash">/</span><strong>{page === "create" ? "Создать кампанию" : "Редактор офферов"}</strong></div>
          <div className={`connection ${connection}`}><span className="status-dot" />{connection === "ready" ? "Keitaro подключён" : connection === "checking" ? "Проверяем подключение" : connection === "missing" ? "Нужна настройка" : "Keitaro недоступен"}</div>
        </header>
        <main className="main-content">
          <div className="page-heading">
            <div><span className="eyebrow"><span className="eyebrow-line" /> УПРАВЛЕНИЕ КАМПАНИЯМИ</span><h1>{page === "create" ? "Создание кампании" : "Распределение офферов"}<span className="heading-period">.</span></h1><p>{page === "create" ? "Создайте кампанию Keitaro и настройте перенаправления по странам." : "Добавляйте, удаляйте и распределяйте офферы в существующем потоке Keitaro."}</p></div>
            <a className="version-chip keitaro-link" href={KEITARO_EMULATOR_ADMIN_URL} target="_blank" rel="noopener noreferrer" title="Открыть тестовый эмулятор Keitaro"><Activity size={15} /> Открыть Keitaro <ExternalLink size={14} /></a>
          </div>

          {notice && <div className={`notice ${notice.kind}`} role="alert"><span>{notice.kind === "success" ? <CheckCircle2 size={20} /> : <CircleAlert size={20} />}</span><p>{notice.message}</p><button aria-label="Закрыть уведомление" onClick={() => setNotice(null)}><X size={17} /></button></div>}

          {page === "create" ? (
            <div className="workspace-grid">
              <section className="panel form-panel">
                <div className="panel-heading"><div className="panel-heading-icon"><Target size={20} /></div><div><h2>Параметры кампании</h2><p>Заполните поля и выберите оффер для перенаправления.</p></div><span className="section-index">01</span></div>
                <form onSubmit={(event) => void submitCreate(event)} className="form-grid">
                  <div className="field full">{fieldLabel("campaign-name", "Название кампании")}<input id="campaign-name" required maxLength={200} value={form.name} onChange={(e) => patchForm("name", e.target.value)} placeholder="Например: test_uhtikov_campaign1" disabled={!ready || creating} /></div>
                  <div className="field full">{fieldLabel("geos", "ГЕО — страны", "ISO 3166-1 alpha-2")}<div className="field-icon"><Globe2 size={17} /><input id="geos" required value={form.geos} onChange={(e) => patchForm("geos", e.target.value)} placeholder="AU, MX, RO" disabled={!ready || creating} /></div><small>Посетители из указанных стран попадут в Google. Остальные — на выбранный оффер.</small></div>
                  <div className="field full">{fieldLabel("create-offer-search", "Оффер Keitaro", "Поиск по названию или ID")}<div className="field-icon"><Search size={17} /><input id="create-offer-search" value={form.offerSearch} onChange={(e) => patchForm("offerSearch", e.target.value)} placeholder="Найти оффер..." disabled={!ready || creating} /></div><SelectField id="create-offer" value={form.offerId} onChange={(value) => patchForm("offerId", value)} options={filteredCreateOffers.some((x) => String(x.id) === form.offerId) ? filteredCreateOffers : [...filteredCreateOffers, ...activeOffers.filter((x) => String(x.id) === form.offerId)]} placeholder="Выберите оффер" disabled={!ready || creating} /></div>
                  <div className="form-separator"><span>НАСТРОЙКИ ТРАФИКА</span></div>
                  <div className="field">{fieldLabel("domain", "Домен")}<SelectField id="domain" value={form.domainId} onChange={(value) => patchForm("domainId", value)} options={meta?.domains ?? []} placeholder="Выберите домен" disabled={!ready || creating} /></div>
                  <div className="field">{fieldLabel("group", "Группа кампаний")}<SelectField id="group" value={form.groupId} onChange={(value) => patchForm("groupId", value)} options={meta?.groups ?? []} placeholder="Выберите группу" disabled={!ready || creating} /></div>
                  <div className="field full">{fieldLabel("source", "Источник трафика")}<SelectField id="source" value={form.sourceId} onChange={(value) => patchForm("sourceId", value)} options={meta?.sources ?? []} placeholder="Выберите источник трафика" disabled={!ready || creating} /></div>
                  <div className="form-actions"><span><LockKeyhole size={15} /> Запись только после подтверждения</span><button className="btn primary" disabled={!ready || creating} type="submit">{creating ? "Создаём…" : "Создать кампанию"}<ArrowRight size={17} /></button></div>
                </form>
              </section>
              <div className="right-stack">
                <section className="panel routing-panel"><div className="aside-heading"><span className="eyebrow">СХЕМА ПЕРЕНАПРАВЛЕНИЙ</span><span className="live-chip"><span /> 2 ПОТОКА</span></div><h2>Маршрутизация трафика</h2><p className="aside-lead">Направление перехода зависит от страны посетителя.</p><div className="flow-start"><Globe2 size={20} /><div><strong>Входящий посетитель</strong><small>Трекинговая ссылка Keitaro</small></div></div><div className="flow-line" /><div className="flow-card google"><div className="flow-symbol">G</div><div><span className="flow-label">ПОТОК 01 · ПРИОРИТЕТНЫЙ</span><strong>Переход в Google</strong><small>{form.geos.trim() ? form.geos.toUpperCase().split(/[,;\s]+/).filter(Boolean).join(" · ") : "Выбранные страны"}</small></div><ArrowUpRight size={18} /></div><div className="flow-connector"><span>ОСТАЛЬНОЙ ТРАФИК</span><ArrowDownRight size={17} /></div><div className="flow-card offer"><div className="flow-symbol"><Target size={19} /></div><div><span className="flow-label">ПОТОК 02 · ПО УМОЛЧАНИЮ</span><strong>Выбранный оффер</strong><small>{form.offerId ? `Оффер №${form.offerId}` : "Все остальные страны"}</small></div><ArrowUpRight size={18} /></div><div className="routing-foot"><CheckCircle2 size={16} /><span>Приоритет потоков: по позиции</span></div></section>
                <div className="tip-card"><div className="tip-icon"><ShieldCheck size={20} /></div><div><strong>Безопасная работа</strong><p>API-ключ доступен только backend FastAPI. Создание кампании требует подтверждения.</p></div></div>
                {created && <section className="panel created-card"><span className="eyebrow">СОЗДАНО В KEITARO</span><h3>{created.name} · #{created.id}</h3><a href={created.admin_url} target="_blank" rel="noopener noreferrer">Открыть в Keitaro <ExternalLink size={15} /></a><button className="text-button" onClick={() => void navigator.clipboard.writeText(created.admin_url)}><Copy size={15} /> Копировать ссылку на кампанию</button></section>}
              </div>
            </div>
          ) : (
            <div className="workspace-grid">
              <section className="panel editor-panel">
                <div className="panel-heading"><div className="panel-heading-icon"><SlidersHorizontal size={20} /></div><div><h2>Редактор офферов потока</h2><p>Выберите кампанию и поток, затем измените состав и доли офферов.</p></div><span className="section-index">02</span></div>
                <div className="editor-pickers"><div className="field">{fieldLabel("campaign", "Кампания")}<div className="select-wrap"><select id="campaign" value={campaignId} disabled={!ready || editorBusy} onChange={(e) => void chooseCampaign(e.target.value)}><option value="">Выберите кампанию</option>{campaigns.map((item) => <option key={item.id} value={item.id}>{item.name} · #{item.id}</option>)}</select><ChevronDown size={16} className="select-chevron" /></div></div><div className="field">{fieldLabel("stream", "Поток с офферами")}<div className="select-wrap"><select id="stream" value={streamId} disabled={!campaignId || editorBusy || !availableStreams.length} onChange={(e) => void chooseStream(e.target.value)}><option value="">Выберите поток</option>{availableStreams.map((item) => <option key={item.id} value={item.id}>{item.name} · #{item.id}</option>)}</select><ChevronDown size={16} className="select-chevron" /></div></div></div>
                <div className="editor-toolbar"><span><span className="toolbar-dot" />{stream ? `Поток №${stream.id} · ${stream.name}` : editorBusy ? "Загружаем данные Keitaro…" : campaignId && !availableStreams.length ? "Нет потоков для редактирования офферов" : "Для начала выберите кампанию"}</span><button className="btn outline small" onClick={() => void reloadStream()} disabled={!stream || editorBusy}><RefreshCcw size={15} /> Обновить</button></div>
                {!stream ? <div className="empty-state"><div className="empty-illustration"><Layers3 size={34} /></div><h3>Поток не выбран</h3><p>Выберите кампанию и поток с офферами, чтобы изменить их доли трафика.</p></div> : <>
                  <div className="offer-table-head"><span>ОФФЕР</span><span>ДОЛЯ ТРАФИКА</span><span>ДЕЙСТВИЕ</span></div>
                  <div className="offer-list">{rows.map((row) => <div className={`offer-row ${row.removed ? "removed" : ""}`} key={row.id}><div className="offer-name"><span className="offer-avatar"><Target size={17} /></span><div><strong>{row.name}</strong><small>Оффер №{row.id}</small></div></div><div className="share-group">{row.removed ? <span className="removed-label">0% · Удалён</span> : <><div className="share-input"><input type="number" aria-label={`Доля оффера №${row.id}`} min="0" max="100" step="1" value={emptyShareIds.includes(row.id) ? "" : row.share} disabled={editorBusy} onChange={(e) => updateShare(row.id, e.target.value)} /><span>%</span></div><button className={`icon-btn ${row.locked ? "locked" : ""}`} title={row.locked ? "Открепить долю" : "Закрепить долю"} aria-label={row.locked ? `Открепить долю оффера №${row.id}` : `Закрепить долю оффера №${row.id}`} disabled={editorBusy} onClick={() => togglePin(row.id)}><LockKeyhole size={16} /></button></>}</div><div className="offer-action"><button className={`btn ${row.removed ? "outline restore" : "danger-ghost"} small`} disabled={editorBusy} onClick={() => toggleRemoved(row.id)}>{row.removed ? <><RotateCcw size={15} /> Вернуть</> : <><Trash2 size={15} /> Удалить</>}</button></div></div>)}</div>
                  <div className="add-section"><div className="add-heading"><Plus size={17} /><strong>Добавить оффер</strong></div><div className="add-grid"><div className="field-icon"><Search size={16} /><input aria-label="Поиск офферов для добавления" value={offerSearch} onChange={(e) => setOfferSearch(e.target.value)} placeholder="Поиск по названию или ID" disabled={editorBusy} /></div><div className="select-wrap"><select aria-label="Выбор оффера для добавления" value={addOfferId} disabled={editorBusy} onChange={(e) => setAddOfferId(e.target.value)}><option value="">Выберите оффер</option>{(filteredEditOffers.some((x) => String(x.id) === addOfferId) ? filteredEditOffers : [...filteredEditOffers, ...activeOffers.filter((x) => String(x.id) === addOfferId)]).map((item) => <option key={item.id} value={item.id}>{item.name} · #{item.id}</option>)}</select><ChevronDown size={16} className="select-chevron" /></div><button className="btn outline" onClick={addOffer} disabled={!addOfferId || editorBusy}><Plus size={17} /> Добавить</button></div></div>
                  <div className="editor-footer"><div className={`total ${valid ? "" : "invalid"}`}><span>Всего распределено</span><strong>{sum}% <span>/ 100%</span></strong>{!valid && <small className="share-validation-message">Для сохранения сумма долей должна быть 100%. Снимите закрепление или измените проценты.</small>}</div><div className="editor-buttons"><button className="btn outline" disabled={!dirty || editorBusy} onClick={() => { discardEditorChanges(); setNotice(null); }}><X size={16} /> Отменить</button><button className="btn primary" disabled={!dirty || !valid || editorBusy} onClick={() => void saveOffers()}><Save size={17} /> {editorBusy ? "Сохраняем…" : "Сохранить в Keitaro"}</button></div></div>
                </>}
              </section>
              <div className="right-stack"><section className="panel summary-panel"><span className="eyebrow">ОБЗОР ПОТОКА</span><h2>Распределение трафика</h2><p className="aside-lead">Проверьте распределение активных офферов перед сохранением.</p><div className="summary-stat"><span>Активных офферов</span><strong>{activeRows.length}</strong></div><div className="summary-stat"><span>Распределено трафика</span><strong className={valid ? "good" : "bad"}>{sum}%</strong></div><div className="summary-stat"><span>Несохранённые изменения</span><strong>{dirty ? "Да" : "Нет"}</strong></div><div className="share-bar" aria-label={`Распределено трафика: ${sum}%`}><span style={{ width: `${Math.min(sum, 100)}%` }} /></div><div className="summary-tip"><CircleAlert size={16} /><p>Изменения не отправляются в Keitaro до нажатия <strong>«Сохранить в Keitaro»</strong>. После сохранения поток загружается повторно для проверки.</p></div></section><div className="tip-card"><div className="tip-icon"><Check size={20} /></div><div><strong>Точные проценты</strong><p>Незакреплённые офферы делят оставшийся процент без ошибок округления.</p></div></div></div>
            </div>
          )}
          <footer className="page-footer"><span>© Adrobot · Управление кампаниями Keitaro</span><span>Локальная панель <span className="footer-separator">·</span> Без фоновой записи</span></footer>
        </main>
      </div>
    </div>
  );
}

function getMessage(error: unknown) {
  return error instanceof Error ? error.message : "Непредвиденная ошибка. Попробуйте ещё раз.";
}
