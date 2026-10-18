'use strict';

/*
 * Облачная синхронизация между устройствами.
 *
 * Каждое событие, задача и календарь хранится на сервере отдельной строкой. На устройстве хранится
 * «тень» — каким каждый объект был на сервере при последней синхронизации. Сравнивая с ней, движок
 * понимает, что поменялось здесь (отправить), а что — на другом устройстве (принять). Если объект
 * поменяли и тут, и там, побеждает последнее сохранение (локальное уходит на сервер следом).
 *
 * Движок (createSyncEngine) не зависит от DOM и Supabase — его проверяют тесты в Node.
 */

const SYNC_KINDS = ['event', 'task', 'calendar'];

/** JSON с отсортированными ключами: Postgres (jsonb) хранит ключи в своём порядке. */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * readLocal()      → { event: [...], task: [...], calendar: [...] } — текущие данные на устройстве
 * applyRemote(ch)  ← { event: { set: [obj], del: [id] }, task: …, calendar: … } — изменения с сервера
 * prepare(kind, o) → объект в том виде, в каком он уходит на сервер (нормализованный, без локальных полей)
 * backend.pull(since) → строки { kind, id, data, deleted, updated_at } новее since (ISO-время сервера)
 * backend.push(rows)  ← строки { kind, id, data, deleted }
 * store            — { get(), set(state) } для тени и курсора; хранится отдельно для каждого аккаунта
 */
function createSyncEngine({ backend, readLocal, applyRemote, prepare, store, onStatus = () => {} }) {
  let running = null;
  let again = false;

  const canon = (kind, obj) => stableStringify(prepare(kind, obj));

  function indexLocal() {
    const map = new Map();
    const local = readLocal();
    for (const kind of SYNC_KINDS) {
      for (const obj of local[kind] || []) {
        const data = prepare(kind, obj);
        map.set(`${kind}:${obj.id}`, { kind, id: String(obj.id), data, json: stableStringify(data) });
      }
    }
    return map;
  }

  async function runOnce() {
    const saved = store.get() || {};
    const shadow = { ...(saved.shadow || {}) };
    let cursor = saved.cursor || null;

    // 1. Принимаем изменения с сервера
    const rows = await backend.pull(cursor);
    const local = indexLocal();
    const changes = Object.fromEntries(SYNC_KINDS.map((k) => [k, { set: [], del: [] }]));
    let changed = false;
    for (const r of rows) {
      if (!SYNC_KINDS.includes(r.kind)) continue;
      const key = `${r.kind}:${r.id}`;
      const remoteJson = r.deleted || r.data == null ? null : canon(r.kind, r.data);
      const localJson = local.get(key)?.json ?? null;
      const shadowJson = shadow[key] ?? null;
      if (localJson === shadowJson && remoteJson !== localJson) {
        // Здесь объект не меняли — берём серверную версию
        if (remoteJson === null) changes[r.kind].del.push(String(r.id));
        else changes[r.kind].set.push(r.data);
        changed = true;
      }
      if (localJson === shadowJson || localJson === remoteJson) {
        if (remoteJson === null) delete shadow[key];
        else shadow[key] = remoteJson;
      }
      // Иначе объект изменён и здесь — локальная версия уйдёт на сервер ниже
      if (!cursor || Date.parse(r.updated_at) > Date.parse(cursor)) cursor = r.updated_at;
    }
    if (changed) applyRemote(changes);
    store.set({ shadow, cursor });

    // 2. Отправляем то, что поменялось на устройстве
    const now = indexLocal();
    const out = [];
    for (const [key, item] of now) {
      if (shadow[key] !== item.json) out.push({ kind: item.kind, id: item.id, data: item.data, deleted: false });
    }
    for (const key of Object.keys(shadow)) {
      if (!now.has(key)) {
        const i = key.indexOf(':');
        out.push({ kind: key.slice(0, i), id: key.slice(i + 1), data: null, deleted: true });
      }
    }
    if (out.length) {
      await backend.push(out);
      for (const row of out) {
        const key = `${row.kind}:${row.id}`;
        if (row.deleted) delete shadow[key];
        else shadow[key] = stableStringify(row.data);
      }
      store.set({ shadow, cursor });
    }
    return { pulled: rows.length, applied: changed, pushed: out.length };
  }

  /** Синхронизирует; повторный вызов во время работы ставит ещё один проход в очередь. */
  async function sync() {
    if (running) {
      again = true;
      return running;
    }
    onStatus('syncing');
    running = (async () => {
      let result;
      try {
        do {
          again = false;
          result = await runOnce();
        } while (again);
        onStatus('ok', result);
      } catch (err) {
        onStatus('error', err);
      } finally {
        running = null;
      }
      return result;
    })();
    return running;
  }

  return { sync };
}

/* ---------- Supabase ---------- */

function supabaseBackend(client, userId) {
  const PAGE = 1000;
  return {
    async pull(since) {
      const rows = [];
      for (let from = 0; ; from += PAGE) {
        let q = client.from('items').select('kind,id,data,deleted,updated_at')
          .order('updated_at', { ascending: true })
          .range(from, from + PAGE - 1);
        // Небольшой запас по времени: строки, записанные в ту же секунду, не потеряются (повтор безвреден)
        if (since) q = q.gte('updated_at', new Date(Date.parse(since) - 5000).toISOString());
        const { data, error } = await q;
        if (error) throw error;
        rows.push(...data);
        if (data.length < PAGE) return rows;
      }
    },
    async push(rows) {
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500).map((r) => ({ ...r, user_id: userId }));
        const { error } = await client.from('items').upsert(chunk, { onConflict: 'user_id,kind,id' });
        if (error) throw error;
      }
    },
  };
}

if (typeof module !== 'undefined') {
  module.exports = { createSyncEngine, stableStringify, SYNC_KINDS };
}

/* ---------- Подключение к приложению ---------- */

/* global state, h, $, readJSON, writeJSON, render, toast, normalizeEvent, normalizeTask, normalizeCalendar,
   STORE_KEY, TASKS_KEY, CALS_KEY, DEFAULT_CALENDARS, closeNav */

const SUPABASE_SRC = 'vendor/supabase-2.117.2.js';
const sync = {
  client: null,
  user: null,
  engine: null,
  status: 'off', // off | signed-out | syncing | ok | offline | error
  lastSync: null,
  applying: false,
  timer: null,
  channel: null,
  pendingEmail: null,
};

const syncConfigured = () => {
  const c = window.SYNC_CONFIG || {};
  return Boolean(c.supabaseUrl && c.supabaseKey);
};

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Не загрузился ${src}`));
    document.head.append(s);
  });
}

/** То, что уходит на сервер: нормализованный объект; видимость календаря у каждого устройства своя. */
function prepareForSync(kind, obj) {
  if (kind === 'event') return normalizeEvent(obj);
  if (kind === 'task') return normalizeTask(obj);
  const { visible, ...rest } = normalizeCalendar(obj);
  return rest;
}

function applyRemoteChanges(changes) {
  const merge = (list, { set, del }, normalize, keep = () => ({})) => {
    const byId = new Map(list.map((x) => [x.id, x]));
    for (const id of del) byId.delete(id);
    for (const raw of set) {
      const obj = normalize(raw);
      if (!obj) continue;
      const prev = byId.get(obj.id);
      byId.set(obj.id, prev ? Object.assign(prev, obj, keep(prev)) : { ...obj, ...keep(null) });
    }
    return [...byId.values()];
  };
  sync.applying = true;
  try {
    state.events = merge(state.events, changes.event, normalizeEvent);
    state.tasks = merge(state.tasks, changes.task, normalizeTask);
    state.calendars = merge(state.calendars, changes.calendar, normalizeCalendar, (prev) => ({ visible: prev ? prev.visible : true }));
    if (!state.calendars.length) state.calendars = DEFAULT_CALENDARS.map((c) => ({ ...c }));
    writeJSON(STORE_KEY, state.events);
    writeJSON(TASKS_KEY, state.tasks);
    writeJSON(CALS_KEY, state.calendars);
  } finally {
    sync.applying = false;
  }
  render();
}

function setSyncStatus(status, detail) {
  if (status === 'error') {
    sync.status = navigator.onLine === false ? 'offline' : 'error';
    sync.error = detail;
    console.warn('Синхронизация:', detail);
  } else {
    sync.status = status;
    if (status === 'ok') sync.lastSync = new Date();
  }
  renderSyncStatus();
}

/** Вызывается при каждом сохранении данных на устройстве. */
function syncSoon(delay = 1200) {
  if (!sync.engine || sync.applying) return;
  clearTimeout(sync.timer);
  sync.timer = setTimeout(() => sync.engine.sync(), delay);
}

function startEngine() {
  const key = `everyday-calendar:sync:${sync.user.id}`;
  sync.engine = createSyncEngine({
    backend: supabaseBackend(sync.client, sync.user.id),
    readLocal: () => ({ event: state.events, task: state.tasks, calendar: state.calendars }),
    applyRemote: applyRemoteChanges,
    prepare: prepareForSync,
    store: { get: () => readJSON(key, null), set: (v) => writeJSON(key, v) },
    onStatus: setSyncStatus,
  });
  sync.engine.sync();

  // Мгновенные обновления, когда данные меняются на другом устройстве
  sync.channel?.unsubscribe();
  sync.channel = sync.client.channel(`items-${sync.user.id}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'items', filter: `user_id=eq.${sync.user.id}` }, () => syncSoon(300))
    .subscribe();
}

function stopEngine() {
  clearTimeout(sync.timer);
  sync.channel?.unsubscribe();
  sync.channel = null;
  sync.engine = null;
}

async function initSync() {
  if (!syncConfigured()) {
    setSyncStatus('off');
    return;
  }
  try {
    if (!window.supabase) await loadScript(SUPABASE_SRC);
    const c = window.SYNC_CONFIG;
    sync.client = window.supabase.createClient(c.supabaseUrl, c.supabaseKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
  } catch (err) {
    setSyncStatus('error', err);
    return;
  }

  sync.client.auth.onAuthStateChange((event, session) => {
    const user = session?.user || null;
    if (user?.id === sync.user?.id) return;
    sync.user = user;
    if (user) {
      // Запросы к Supabase изнутри этого обработчика могут зависнуть — запускаем следующим тиком
      setTimeout(startEngine, 0);
      if (event === 'SIGNED_IN') toast(`Вы вошли: ${user.email || 'аккаунт'}. Данные синхронизируются`);
    } else {
      stopEngine();
      setSyncStatus('signed-out');
    }
    renderSyncDialog();
  });
  const { data } = await sync.client.auth.getSession();
  if (!data.session) setSyncStatus('signed-out');

  window.addEventListener('online', () => syncSoon(200));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) syncSoon(200); });
  setInterval(() => syncSoon(0), 60000);
}

/* ---------- Интерфейс ---------- */

function timeAgo(d) {
  const s = Math.round((Date.now() - d) / 1000);
  if (s < 60) return 'только что';
  if (s < 3600) return `${Math.floor(s / 60)} мин назад`;
  return `в ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function syncStatusText() {
  switch (sync.status) {
    case 'off': return ['☁', 'Синхронизация не настроена'];
    case 'signed-out': return ['☁', 'Войдите, чтобы синхронизировать устройства'];
    case 'syncing': return ['↻', 'Синхронизация…'];
    case 'ok': return ['✓', `Синхронизировано ${sync.lastSync ? timeAgo(sync.lastSync) : ''}`];
    case 'offline': return ['⚠', 'Нет сети — изменения сохранены и отправятся позже'];
    default: return ['⚠', 'Ошибка синхронизации — повторим автоматически'];
  }
}

function renderSyncStatus() {
  const [icon, text] = syncStatusText();
  const btn = $('#btnSync');
  if (!btn) return;
  btn.dataset.status = sync.status;
  btn.title = text;
  btn.setAttribute('aria-label', text);
  btn.textContent = icon;
  const side = $('#btnSyncSide');
  if (side) side.textContent = `${icon} ${sync.user ? (sync.user.email || 'Аккаунт') : 'Синхронизация'}`;
  if ($('#syncDialog')?.open) renderSyncDialog();
}

function renderSyncDialog() {
  const body = $('#syncBody');
  if (!body) return;
  const [icon, text] = syncStatusText();

  if (!syncConfigured()) {
    body.replaceChildren(
      h('p', {}, 'Сейчас календарь хранит данные только на этом устройстве.'),
      h('p', {}, 'Чтобы видеть одни и те же события и задачи на телефоне и компьютере, нужно один раз подключить бесплатное облако Supabase — инструкция в файле ',
        h('code', {}, 'docs/SYNC_SETUP.md'), ' репозитория.'),
      h('p', { class: 'muted' }, 'А пока можно переносить данные вручную: ☰ → «Данные» → резервная копия и импорт.'));
    return;
  }

  if (sync.user) {
    body.replaceChildren(
      h('div', { class: 'sync-account' },
        h('div', { class: 'sync-avatar' }, (sync.user.email || '?')[0].toUpperCase()),
        h('div', {}, h('strong', {}, sync.user.email || 'Аккаунт'), h('small', {}, `${icon} ${text}`))),
      h('p', { class: 'muted' }, 'Войдите под этим же email на других устройствах — события, задачи и календари будут общими. Какие календари показывать, каждое устройство решает само.'),
      sync.status === 'error' && sync.error ? h('p', { class: 'sync-error' }, String(sync.error.message || sync.error)) : null,
      h('div', { class: 'dialog-foot' },
        h('button', { class: 'btn danger-text', type: 'button', onclick: signOut }, 'Выйти'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn primary', type: 'button', onclick: () => sync.engine?.sync() }, 'Синхронизировать сейчас')));
    return;
  }

  if (sync.pendingEmail) {
    const code = h('input', { class: 'sync-code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '10', placeholder: '123456', 'aria-label': 'Код из письма' });
    const form = h('form', {
      class: 'sync-form',
      onsubmit: async (e) => {
        e.preventDefault();
        const token = code.value.replace(/\s/g, '');
        if (!token) return;
        const btn = $('button[type=submit]', form);
        btn.disabled = true;
        const { error } = await sync.client.auth.verifyOtp({ email: sync.pendingEmail, token, type: 'email' });
        btn.disabled = false;
        if (error) {
          toast('Код не подошёл или устарел. Проверьте письмо или запросите новый');
          return;
        }
        sync.pendingEmail = null;
        $('#syncDialog').close();
      },
    },
    h('p', {}, 'Мы отправили письмо на ', h('strong', {}, sync.pendingEmail), '. Введите код из письма (или просто откройте ссылку в нём на этом устройстве).'),
    code,
    h('div', { class: 'dialog-foot' },
      h('button', { class: 'btn', type: 'button', onclick: () => { sync.pendingEmail = null; renderSyncDialog(); } }, 'Другой email'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn primary', type: 'submit' }, 'Войти')));
    body.replaceChildren(form);
    setTimeout(() => code.focus(), 50);
    return;
  }

  const email = h('input', { type: 'email', class: 'sync-email', required: true, autocomplete: 'email', placeholder: 'you@example.com', 'aria-label': 'Email' });
  const form = h('form', {
    class: 'sync-form',
    onsubmit: async (e) => {
      e.preventDefault();
      const btn = $('button[type=submit]', form);
      btn.disabled = true;
      const { error } = await sync.client.auth.signInWithOtp({
        email: email.value.trim(),
        options: { emailRedirectTo: location.href.split('#')[0].split('?')[0] },
      });
      btn.disabled = false;
      if (error) {
        toast(/rate|limit|seconds/i.test(error.message) ? 'Слишком часто. Подождите минуту и попробуйте снова' : `Не удалось отправить письмо: ${error.message}`);
        return;
      }
      sync.pendingEmail = email.value.trim();
      renderSyncDialog();
    },
  },
  h('p', {}, 'Войдите, чтобы события и задачи были одинаковыми на телефоне и компьютере. Пароль не нужен — пришлём код на почту.'),
  email,
  h('div', { class: 'dialog-foot' },
    window.SYNC_CONFIG.google
      ? h('button', {
        class: 'btn',
        type: 'button',
        onclick: () => sync.client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.href.split('#')[0].split('?')[0] } }),
      }, 'Войти через Google')
      : null,
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn primary', type: 'submit' }, 'Получить код')),
  h('p', { class: 'muted' }, 'Данные, которые уже есть на этом устройстве, объединятся с облаком — ничего не пропадёт.'));
  body.replaceChildren(form);
  setTimeout(() => email.focus(), 50);
}

async function signOut() {
  const user = sync.user;
  await sync.engine?.sync();
  await sync.client.auth.signOut();
  if (user) writeJSON(`everyday-calendar:sync:${user.id}`, null);
  $('#syncDialog').close();
  toast('Вы вышли. Данные остались на этом устройстве');
}

function openSyncDialog() {
  closeNav();
  renderSyncDialog();
  $('#syncDialog').showModal();
}
