'use strict';

/*
 * Друзья и ссылки: свой календарь можно показать другу (по email, он принимает приглашение у себя)
 * или по секретной ссылке (без аккаунта). Чужие календари — слои поверх своего, только для просмотра.
 * Что отдаёт сервер, решают функции в supabase/friends.sql; здесь — окна и показ.
 */

/* global state, sync, h, $, $$, toast, render, saveSettings, closeNav, formatDate, formatTime, capitalize, fromKey,
   COLORS, SHARE_LEVELS, normalizeShareSettings, buildLayer, nameMatches */

const friends = {
  invites: [], // приглашения мне: { id, owner_name }
  mine: null, // мои доступы (для окна «Поделиться»), загружаются при открытии
  loadedAt: 0,
  loading: null,
  missingTable: false,
};

/** Слой по ключу: «s:<id доступа>» — друг, «l:<токен>» — ссылка. */
const findLayer = (key) => (state.layers || []).find((l) => l.key === key);

/** Календарь-«категория» для событий слоя: цвет и переключатель у слоя свои. */
function layerCal(key) {
  const l = findLayer(key);
  return l ? { id: key, name: l.name, color: l.color, visible: l.visible } : { id: key, name: 'Друг', color: '#6b7280', visible: false };
}

/** События включённых слоёв. */
const visibleLayerEvents = () => (state.layers || []).filter((l) => l.visible).flatMap((l) => l.events);

const shareLink = (token) => `${location.origin}${location.pathname}?share=${token}`;
const myShareName = () => state.settings.shareName || (sync.user?.email || '').split('@')[0] || 'Я';

/* ---------- Загрузка чужих календарей ---------- */

function layerColor(key) {
  state.settings.layerColors ||= {};
  if (!state.settings.layerColors[key]) {
    const used = new Set([...state.calendars.map((c) => c.color), ...Object.values(state.settings.layerColors)]);
    state.settings.layerColors[key] = COLORS.find((c) => !used.has(c)) || COLORS[(Object.keys(state.settings.layerColors).length + 3) % COLORS.length];
    saveSettings();
  }
  return state.settings.layerColors[key];
}

function makeLayer(key, type, rows, extra) {
  const built = buildLayer(rows, key);
  return {
    key, type, cals: built.cals, events: built.events, color: layerColor(key), visible: !state.settings.layerHidden?.[key],
    ...extra, name: extra.name || built.ownerName || 'Календарь',
  };
}

/** Загружает календари друзей и ссылок. Повторный вызов во время загрузки ждёт текущую. */
function loadLayers() {
  if (!sync.client) return Promise.resolve();
  friends.loading ||= (async () => {
    const layers = [];
    const links = state.settings.links || [];
    const linkJobs = links.map(async (link) => {
      const key = `l:${link.token}`;
      const { data, error } = await sync.client.rpc('link_items', { p_token: link.token });
      if (error) return { key, type: 'link', token: link.token, name: link.name || 'Календарь по ссылке', cals: new Map(), events: [], color: layerColor(key), visible: false, error: error.message };
      if (!data.length) return { key, type: 'link', token: link.token, name: link.name || 'Календарь по ссылке', cals: new Map(), events: [], color: layerColor(key), visible: false, error: 'Ссылку отозвали' };
      return makeLayer(key, 'link', data, { token: link.token });
    });
    let friendJobs = [];
    friends.invites = [];
    if (sync.user) {
      const { data: incoming, error } = await sync.client.from('shares').select('id, owner, owner_name, accepted').eq('kind', 'friend').neq('owner', sync.user.id);
      friends.missingTable = Boolean(error && /shares|relation|schema cache/i.test(error.message || ''));
      if (!error) {
        friends.invites = incoming.filter((s) => !s.accepted);
        friendJobs = incoming.filter((s) => s.accepted).map(async (s) => {
          const key = `s:${s.id}`;
          const { data, error: err } = await sync.client.rpc('friend_items', { p_share: s.id });
          const base = { shareId: s.id, name: s.owner_name || 'Друг' };
          if (err) return { key, type: 'friend', ...base, cals: new Map(), events: [], color: layerColor(key), visible: false, error: err.message };
          return makeLayer(key, 'friend', data, base);
        });
      }
    }
    for (const l of await Promise.all([...friendJobs, ...linkJobs])) layers.push(l);
    // Своя же ссылка, открытая у себя, — не нужна как чужой календарь
    const myTokens = new Set((friends.mine || []).map((s) => s.token));
    state.layers = layers.filter((l) => !(l.type === 'link' && myTokens.has(l.token)));
    // Имя для ссылки запоминаем, чтобы показать его, даже если ссылку отзовут
    let changed = false;
    for (const l of state.layers) {
      const link = links.find((x) => l.type === 'link' && x.token === l.token);
      if (link && !l.error && link.name !== l.name) { link.name = l.name; changed = true; }
    }
    if (changed) saveSettings();
    friends.loadedAt = Date.now();
    render();
  })().catch((err) => console.warn('Друзья:', err)).finally(() => { friends.loading = null; });
  return friends.loading;
}

/* ---------- Панель слева: друзья и приглашения ---------- */

function setLayerVisible(key, visible) {
  state.settings.layerHidden ||= {};
  if (visible) delete state.settings.layerHidden[key];
  else state.settings.layerHidden[key] = true;
  saveSettings();
  const l = findLayer(key);
  if (l) l.visible = visible;
  render();
}

function cycleLayerColor(key) {
  const cur = layerColor(key);
  state.settings.layerColors[key] = COLORS[(COLORS.indexOf(cur) + 1) % COLORS.length];
  saveSettings();
  const l = findLayer(key);
  if (l) l.color = state.settings.layerColors[key];
  render();
}

async function removeLayer(l) {
  if (!confirm(`Убрать «${l.name}» из своего календаря?${l.type === 'friend' ? ' Чтобы снова видеть его, понадобится новое приглашение.' : ''}`)) return;
  if (l.type === 'link') {
    state.settings.links = (state.settings.links || []).filter((x) => x.token !== l.token);
  } else {
    const { error } = await sync.client.from('shares').delete().eq('id', l.shareId);
    if (error) return toast(`Не получилось: ${error.message}`);
  }
  delete state.settings.layerColors?.[l.key];
  delete state.settings.layerHidden?.[l.key];
  saveSettings();
  state.layers = state.layers.filter((x) => x.key !== l.key);
  render();
}

async function answerInvite(inv, accept) {
  const { error } = accept
    ? await sync.client.rpc('accept_share', { p_id: inv.id })
    : await sync.client.from('shares').delete().eq('id', inv.id);
  if (error) return toast(`Не получилось: ${error.message}`);
  toast(accept ? `Теперь вы видите календарь: ${inv.owner_name || 'друг'}` : 'Приглашение отклонено');
  await loadLayers();
}

function renderFriends() {
  const box = $('#friendList');
  if (!box) return;
  $('#friendsSection').hidden = !sync.client;
  const rows = [
    ...friends.invites.map((inv) => h('div', { class: 'invite-row' },
      h('span', {}, h('strong', {}, inv.owner_name || 'Друг'), ' показывает вам свой календарь'),
      h('div', { class: 'invite-actions' },
        h('button', { class: 'btn primary small', type: 'button', onclick: () => answerInvite(inv, true) }, 'Принять'),
        h('button', { class: 'btn small', type: 'button', onclick: () => answerInvite(inv, false) }, 'Отклонить')))),
    ...(state.layers || []).map((l) => h('div', {
      class: `cal-row${l.visible ? '' : ' is-off'}`,
      style: { '--c': l.color },
      title: l.error ? `Не загрузился: ${l.error}` : null,
    },
    h('label', { class: 'switch' },
      h('input', { type: 'checkbox', role: 'switch', checked: l.visible, disabled: Boolean(l.error), onchange: (e) => setLayerVisible(l.key, e.target.checked) }),
      h('span', { class: 'switch-track' }),
      h('span', { class: 'cal-name' }, l.type === 'link' ? '🔗 ' : '👤 ', l.name, l.error ? ' ⚠︎' : '')),
    h('button', { class: 'cal-action', type: 'button', title: 'Другой цвет', onclick: () => cycleLayerColor(l.key) }, '🎨'),
    h('button', { class: 'cal-action', type: 'button', title: 'Убрать', 'aria-label': `Убрать «${l.name}»`, onclick: () => removeLayer(l) }, '✕'))),
  ];
  box.replaceChildren(...(rows.length ? rows : [h('div', { class: 'side-empty' },
    friends.missingTable ? 'Чтобы делиться календарём, выполните supabase/friends.sql в Supabase' : 'Поделитесь своим календарём кнопкой ＋ или откройте ссылку друга')]));
}

/** Переключатели слоёв в полосе категорий на телефоне. */
function layerChips() {
  return (state.layers || []).filter((l) => !l.error).map((l) => h('button', {
    class: `cal-chip${l.visible ? ' is-on' : ''}`,
    type: 'button',
    'aria-pressed': String(l.visible),
    style: { '--c': l.color },
    onclick: () => setLayerVisible(l.key, !l.visible),
  }, l.type === 'link' ? '🔗 ' : '👤 ', l.name));
}

/* ---------- Событие друга: только просмотр ---------- */

function openFriendEvent(ev, key) {
  const l = findLayer(ev.friend);
  const cat = l?.cals.get(ev.friendCal)?.name;
  $('#feTitle').textContent = ev.title;
  $('#feWhen').textContent = `${capitalize(formatDate(fromKey(key || ev.date)))} · ${formatTime(ev, key)}`;
  $('#feWho').replaceChildren(h('span', { class: 'fe-dot', style: { '--c': l?.color || '#6b7280' } }), `${l?.name || 'Друг'}${cat ? ` · ${cat}` : ''}`);
  $('#feNotes').textContent = ev.notes || '';
  $('#feNotes').hidden = !ev.notes;
  $('#feBusy').hidden = !ev.busy;
  $('#friendEvent').showModal();
}

/* ---------- Окно «Поделиться календарём» ---------- */

async function loadMyShares() {
  const { data, error } = await sync.client.from('shares').select('*').eq('owner', sync.user.id).order('created_at');
  if (error) {
    friends.missingTable = true;
    throw error;
  }
  friends.mine = data;
  return data;
}

async function openShareDialog() {
  closeNav();
  if (!sync.client) return toast('Делиться календарём можно, когда настроена синхронизация');
  if (!sync.user) return toast('Сначала войдите в аккаунт (☁): друзья видят календарь, сохранённый на сервере', { duration: 7000 });
  $('#shareName').value = myShareName();
  $('#shareList').replaceChildren(h('div', { class: 'side-empty' }, 'Загружаю…'));
  $('#shareDialog').showModal();
  try {
    await loadMyShares();
    renderShareList();
  } catch (err) {
    $('#shareList').replaceChildren(h('div', { class: 'sync-error' },
      /shares|relation|schema cache/i.test(err.message || '')
        ? 'В Supabase ещё нет таблицы для друзей: выполните supabase/friends.sql в SQL Editor (см. docs/SYNC_SETUP.md)'
        : `Не получилось загрузить: ${err.message}`));
  }
}

function levelSummary(settings) {
  const s = normalizeShareSettings(settings);
  const levels = new Set([...state.calendars.map((c) => s.cals[c.id] || s.default), s.tasks]);
  if (levels.size === 1) return SHARE_LEVELS[[...levels][0]];
  return 'выборочно';
}

function renderShareList() {
  const list = friends.mine || [];
  $('#shareList').replaceChildren(...(list.length ? list.map((s) => h('div', { class: 'share-row' },
    h('div', { class: 'share-who' },
      h('strong', {}, s.kind === 'link' ? `🔗 ${s.label || 'Ссылка'}` : `👤 ${s.label || s.email}`),
      h('small', {}, s.kind === 'link'
        ? `По ссылке · ${levelSummary(s.settings)}`
        : `${s.email} · ${s.accepted ? 'видит' : 'ещё не принял'} · ${levelSummary(s.settings)}`)),
    s.kind === 'link' ? h('button', { class: 'btn small', type: 'button', onclick: () => copyLink(s.token) }, 'Копировать') : null,
    h('button', { class: 'icon-btn small', type: 'button', title: 'Настроить', 'aria-label': 'Настроить', onclick: () => openShareEditor(s) }, '✎')))
    : [h('div', { class: 'side-empty' }, 'Пока никто не видит ваш календарь')]));
}

async function copyLink(token) {
  const url = shareLink(token);
  try {
    if (navigator.share && /iPhone|iPad|Android/.test(navigator.userAgent)) {
      await navigator.share({ title: 'Мой календарь', url });
      return;
    }
    await navigator.clipboard.writeText(url);
    toast('Ссылка скопирована. Кто её откроет, увидит ваш календарь так, как вы настроили');
  } catch (err) {
    if (err?.name !== 'AbortError') prompt('Скопируйте ссылку:', url);
  }
}

let editingShare = null; // { id | null, kind }

function openShareEditor(share = null, kind = 'friend') {
  editingShare = { id: share?.id || null, kind: share?.kind || kind };
  const s = normalizeShareSettings(share?.settings);
  const isFriend = editingShare.kind === 'friend';
  $('#shareEditorTitle').textContent = share ? (isFriend ? 'Доступ друга' : 'Доступ по ссылке') : (isFriend ? 'Пригласить друга' : 'Новая ссылка');
  $('#shEmailWrap').hidden = !isFriend;
  $('#shEmail').value = share?.email || '';
  $('#shEmail').required = isFriend;
  $('#shLabel').value = share?.label || '';
  $('#shLabel').placeholder = isFriend ? 'Аня' : 'Для группы';
  $('#shNotes').checked = s.notes;
  $('#shDelete').hidden = !share;
  $('#shLink').hidden = !share || isFriend;
  if (share && !isFriend) $('#shLinkUrl').value = shareLink(share.token);
  const select = (name, value) => h('select', { name },
    ...Object.entries(SHARE_LEVELS).map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
  $('#shCats').replaceChildren(
    ...state.calendars.map((c) => h('label', { class: 'share-cat', style: { '--c': c.color } },
      h('span', { class: 'share-cat-name' }, h('span', { class: 'fe-dot' }), c.name),
      select(`cal:${c.id}`, s.cals[c.id] || s.default))),
    h('label', { class: 'share-cat' }, h('span', { class: 'share-cat-name' }, '☑ Задачи'), select('tasks', s.tasks)),
    h('label', { class: 'share-cat' }, h('span', { class: 'share-cat-name muted' }, 'Новые категории'), select('default', s.default)));
  $('#shareEditor').showModal();
  (isFriend && !share ? $('#shEmail') : $('#shLabel')).focus();
}

function readShareEditor() {
  const settings = { default: 'busy', cals: {}, tasks: 'busy', notes: $('#shNotes').checked };
  for (const sel of $('#shCats').querySelectorAll('select')) {
    if (sel.name === 'tasks') settings.tasks = sel.value;
    else if (sel.name === 'default') settings.default = sel.value;
    else settings.cals[sel.name.slice(4)] = sel.value;
  }
  return settings;
}

async function saveShare(e) {
  e.preventDefault();
  const settings = readShareEditor();
  const row = { label: $('#shLabel').value.trim(), settings, owner_name: myShareName() };
  if (editingShare.kind === 'friend') {
    const email = $('#shEmail').value.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) return toast('Проверьте email');
    if (email === (sync.user.email || '').toLowerCase()) return toast('Это ваш собственный email');
    row.email = email;
  }
  const q = editingShare.id
    ? sync.client.from('shares').update(row).eq('id', editingShare.id).select().single()
    : sync.client.from('shares').insert({ ...row, kind: editingShare.kind }).select().single();
  const { data, error } = await q;
  if (error) return toast(`Не получилось сохранить: ${error.message}`, { duration: 8000 });
  $('#shareEditor').close();
  await loadMyShares().catch(() => {});
  renderShareList();
  if (!editingShare.id && data.kind === 'link') copyLink(data.token);
  else if (!editingShare.id) {
    toast(`Готово. Пусть ${data.email} войдёт в этот календарь (☁) с этим email — приглашение появится у него слева, в «Друзьях»`, { duration: 10000 });
  } else toast('Сохранено');
}

async function deleteShare() {
  if (!editingShare?.id || !confirm('Закрыть доступ? Друг (или все, у кого есть ссылка) больше не увидит ваш календарь.')) return;
  const { error } = await sync.client.from('shares').delete().eq('id', editingShare.id);
  if (error) return toast(`Не получилось: ${error.message}`);
  $('#shareEditor').close();
  await loadMyShares().catch(() => {});
  renderShareList();
  toast('Доступ закрыт');
}

async function saveShareName() {
  const name = $('#shareName').value.trim().slice(0, 40);
  if (!name || name === state.settings.shareName) return;
  state.settings.shareName = name;
  saveSettings();
  if (sync.user) await sync.client.from('shares').update({ owner_name: name }).eq('owner', sync.user.id);
}

/* ---------- Запуск ---------- */

/** Открыли ссылку друга (?share=…): запоминаем её и показываем его календарь. */
function takeShareParam() {
  const params = new URLSearchParams(location.search);
  const token = params.get('share');
  if (!token || !/^[0-9a-f]{32,128}$/i.test(token)) return null;
  params.delete('share');
  history.replaceState(null, '', `${location.pathname}${params.toString() ? `?${params}` : ''}`);
  state.settings.links ||= [];
  if (!state.settings.links.some((l) => l.token === token)) state.settings.links.push({ token, name: null });
  delete state.settings.layerHidden?.[`l:${token}`];
  saveSettings();
  return token;
}

let pendingShareToken = null;

/** Клиент Supabase готов (вход в аккаунт не обязателен — ссылки работают и без него). */
async function onSyncClient() {
  await loadLayers();
  if (pendingShareToken) {
    const l = findLayer(`l:${pendingShareToken}`);
    if (l && !l.error) toast(`Добавлен календарь «${l.name}» — только для просмотра. Он слева, в «Друзьях»`, { duration: 8000 });
    else if (l) toast(`Не получилось открыть календарь по ссылке: ${l.error}`, { duration: 8000 });
    pendingShareToken = null;
  }
}

/** Вошли или вышли из аккаунта. */
async function onFriendsUser() {
  if (sync.user) await loadMyShares().catch(() => {});
  else friends.mine = null;
  await loadLayers();
}

function initFriends() {
  state.layers = [];
  pendingShareToken = takeShareParam();
  $('#btnShare').addEventListener('click', openShareDialog);
  $('#btnShareSide').addEventListener('click', openShareDialog);
  $('#btnInvite').addEventListener('click', () => openShareEditor(null, 'friend'));
  $('#btnNewLink').addEventListener('click', () => openShareEditor(null, 'link'));
  $('#shareForm').addEventListener('submit', saveShare);
  $('#shDelete').addEventListener('click', deleteShare);
  $('#shCopy').addEventListener('click', () => copyLink($('#shLinkUrl').value.split('share=')[1]));
  $('#shareName').addEventListener('change', saveShareName);
  // Чужие календари обновляются при возвращении в приложение и раз в 5 минут
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - friends.loadedAt > 60000) loadLayers();
  });
  setInterval(() => { if (!document.hidden) loadLayers(); }, 5 * 60000);
}

/** Слой для совместного поиска окна: «с Аней» → ключ слоя. */
function layerByName(word) {
  return (state.layers || []).find((l) => !l.error && nameMatches(word, l.name)) || null;
}
