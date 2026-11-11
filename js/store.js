window.LAMP_VERSION = "1.4.1";
/*
 * Lamp's local-first store.
 * Every record is a JSON document addressed by (collection, id), kept in this
 * device's localStorage and synced to one Supabase table ("docs").
 * Writes land locally first (so the app works offline at the gym), go into an
 * outbox, and are pushed when the network is back. Other devices' changes
 * arrive by realtime events and by a catch-up pull on focus / reconnect.
 */
(function () {
  function createStore(opts) {
    const { client, userId, onChange, onStatus } = opts;
    const K = name => `lamp:${userId}:${name}`;
    const load = (name, fallback) => { try { const v = localStorage.getItem(K(name)); return v ? JSON.parse(v) : fallback; } catch { return fallback; } };
    const keep = (name, v) => { try { localStorage.setItem(K(name), JSON.stringify(v)); } catch (e) { console.warn("Lamp: local save failed", e); } };

    let docs = load("docs", {});      // "col/id" -> {col,id,data,deleted,updated_at}
    let outbox = load("outbox", {});  // "col/id" -> row waiting to be pushed
    let since = load("since", "1970-01-01T00:00:00Z");
    let status = "idle", lastSynced = load("lastSynced", null), flushing = false, pulling = false, timer = null, channel = null;

    const key = (c, i) => c + "/" + i;
    const persist = () => { keep("docs", docs); keep("outbox", outbox); };
    const setStatus = s => { status = s; onStatus && onStatus(api.status()); };
    const emit = cols => { if (cols.size) onChange && onChange(cols); };
    const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10)).replace(/-/g, "").slice(0, 20);

    function put(col, id, data, deleted) {
      const row = { col, id: String(id), data: data || {}, deleted: !!deleted, updated_at: new Date().toISOString() };
      docs[key(col, row.id)] = row; outbox[key(col, row.id)] = row; persist();
      emit(new Set([col])); setStatus(navigator.onLine ? "saving" : "offline"); flushSoon();
      return row.id;
    }

    function apply(row) {
      if (!row || !row.col) return false;
      const k = key(row.col, row.id);
      if (outbox[k]) return false;                     // our unsent change wins locally
      const cur = docs[k];
      if (cur && cur.updated_at > row.updated_at) return false;
      docs[k] = { col: row.col, id: row.id, data: row.data || {}, deleted: !!row.deleted, updated_at: row.updated_at };
      return true;
    }

    function flushSoon(ms) { clearTimeout(timer); timer = setTimeout(flush, ms ?? 400); }

    async function flush() {
      const pending = Object.values(outbox);
      if (!pending.length) { if (status !== "offline") setStatus("synced"); return; }
      if (flushing) return flushSoon(800);
      if (!navigator.onLine) return setStatus("offline");
      flushing = true; setStatus("saving");
      try {
        for (let i = 0; i < pending.length; i += 200) {
          const batch = pending.slice(i, i + 200);
          const { error } = await client.from("docs").upsert(
            batch.map(r => ({ user_id: userId, col: r.col, id: r.id, data: r.data, deleted: r.deleted, updated_at: r.updated_at })),
            { onConflict: "user_id,col,id" });
          if (error) throw error;
          batch.forEach(r => { const k = key(r.col, r.id); if (outbox[k] && outbox[k].updated_at === r.updated_at) delete outbox[k]; });
          persist();
        }
        lastSynced = new Date().toISOString(); keep("lastSynced", lastSynced);
        setStatus(Object.keys(outbox).length ? "saving" : "synced");
        if (Object.keys(outbox).length) flushSoon();
      } catch (e) {
        console.warn("Lamp: push failed", e);
        setStatus(navigator.onLine ? "error" : "offline");
        flushSoon(15000);
      } finally { flushing = false; }
    }

    async function pull() {
      if (pulling || !navigator.onLine) { if (!navigator.onLine) setStatus("offline"); return false; }
      pulling = true;
      const changed = new Set();
      try {
        for (let page = 0; page < 50; page++) {
          const { data, error } = await client.from("docs")
            .select("col,id,data,deleted,updated_at,synced_at")
            .gt("synced_at", since).order("synced_at", { ascending: true }).limit(1000);
          if (error) throw error;
          data.forEach(r => { if (apply(r)) changed.add(r.col); if (r.synced_at > since) since = r.synced_at; });
          if (data.length < 1000) break;
        }
        keep("since", since); persist();
        lastSynced = new Date().toISOString(); keep("lastSynced", lastSynced);
        emit(changed);
        setStatus(Object.keys(outbox).length ? "saving" : "synced");
        return true;
      } catch (e) {
        console.warn("Lamp: pull failed", e);
        setStatus(navigator.onLine ? "error" : "offline");
        return false;
      } finally { pulling = false; }
    }

    function listen() {
      if (channel) return;
      channel = client.channel("lamp-docs")
        .on("postgres_changes", { event: "*", schema: "public", table: "docs", filter: `user_id=eq.${userId}` }, payload => {
          const row = payload.new;
          if (row && apply(row)) { persist(); emit(new Set([row.col])); }
        })
        .subscribe();
    }

    async function sync() { await flush(); return pull(); }

    window.addEventListener("online", () => sync());
    window.addEventListener("offline", () => setStatus("offline"));
    document.addEventListener("visibilitychange", () => { if (!document.hidden) sync(); });
    setInterval(() => { if (!document.hidden) sync(); }, 90000);

    const api = {
      all(col) {
        const out = [];
        for (const k in docs) { const r = docs[k]; if (r.col === col && !r.deleted) out.push({ id: r.id, ...r.data }); }
        return out;
      },
      get(col, id) { const r = docs[key(col, id)]; return r && !r.deleted ? { id: r.id, ...r.data } : null; },
      set(col, id, data) { const d = { ...data }; delete d.id; return put(col, id, d, false); },
      add(col, data) { return api.set(col, newId(), data); },
      del(col, id) { return put(col, id, {}, true); },
      sync, pull, flush,
      start() { listen(); return sync(); },
      stop() { if (channel) client.removeChannel(channel); channel = null; },
      status() { return { state: status, pending: Object.keys(outbox).length, lastSynced }; },
      hasLocalData() { return Object.keys(docs).length > 0; },
      // everything currently on this device, for backups
      dump() { return Object.values(docs).filter(r => !r.deleted && r.col !== "session").map(r => ({ col: r.col, id: r.id, data: r.data, updated_at: r.updated_at })); },
      // write many records at once (restore from a backup)
      setMany(rows) {
        const cols = new Set(); const now = new Date().toISOString();
        rows.forEach(r => { if (!r || !r.col || r.id == null || typeof r.data !== "object") return;
          const row = { col: String(r.col), id: String(r.id), data: r.data, deleted: false, updated_at: now };
          docs[key(row.col, row.id)] = row; outbox[key(row.col, row.id)] = row; cols.add(row.col); });
        persist(); emit(cols); setStatus(navigator.onLine ? "saving" : "offline"); flushSoon();
        return cols.size;
      },
    };
    return api;
  }
  window.LampStore = { createStore };
})();
