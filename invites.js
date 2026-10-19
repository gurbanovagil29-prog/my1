'use strict';

/*
 * Приглашения на события. Владелец отмечает друзей в окне события — у них появляется приглашение
 * «Приду / Может быть / Не смогу» (и push или сообщение в Telegram). Принятое становится полноценным
 * событием в календаре друга (копия с полем invite) и переезжает, если владелец меняет время.
 * Хранятся в таблице invites (supabase/update-2.sql); уведомления рассылает функция remind.
 */

/* global state, sync, h, $, toast, render, saveEvents, findEvent, uid, formatDate, formatTime, capitalize, fromKey, toKey,
   relativeDay, shortDate, endMinutes, fromMin, defaultCal, calOf, friendPeople, myShareName, normalizeEvent, colorOf,
   readJSON, writeJSON */

const INVITE_COPIES_KEY = 'everyday-calendar:invite-copies';
const STATUS_LABEL = { pending: 'ждём ответа', accepted: 'придёт ✓', maybe: 'может быть ?', declined: 'не сможет ✕', cancelled: 'отменено' };

const inv = { mine: [], incoming: [], loaded: false, missing: false, reconcileTimer: 0 };

/** Снимок события для приглашения: то, что увидит друг. */
function inviteSnapshot(ev) {
  return {
    title: ev.title, date: ev.date, endDate: ev.endDate || null, start: ev.start || null,
    end: ev.start ? fromMin(endMinutes(ev)) : null, notes: ev.notes || '',
  };
}

const sameSnapshot = (a, b) => ['title', 'date', 'endDate', 'start', 'end', 'notes'].every((k) => (a?.[k] || null) === (b?.[k] || null));

function inviteWhenText(e) {
  const d = fromKey(e.date);
  const day = e.endDate ? `${shortDate(d)} – ${shortDate(fromKey(e.endDate))}` : capitalize(relativeDay(d) || formatDate(d));
  return `${day}${e.start ? `, ${e.start}${e.end ? `–${e.end}` : ''}` : ''}`;
}

/* ---------- Загрузка и сверка ---------- */

async function loadInvites() {
  if (!sync.client || !sync.user) {
    inv.mine = [];
    inv.incoming = [];
    return;
  }
  const { data, error } = await sync.client.from('invites').select('*').or(`owner.eq.${sync.user.id},invitee.eq.${sync.user.id}`);
  inv.missing = Boolean(error);
  if (error) return;
  inv.mine = data.filter((r) => r.owner === sync.user.id);
  inv.incoming = data.filter((r) => r.invitee === sync.user.id);
  inv.loaded = true;
  reconcileIncoming();
}

const copyId = (inviteId) => `inv-${inviteId}`;
const copiesSeen = () => new Set(readJSON(INVITE_COPIES_KEY, []) || []);
function rememberCopy(id, on = true) {
  const set = copiesSeen();
  if (on) set.add(id);
  else set.delete(id);
  writeJSON(INVITE_COPIES_KEY, [...set]);
}

/** Копия принятого приглашения в своём календаре: создать, обновить время, отметить отмену. */
function makeCopy(r, cal = defaultCal()) {
  return normalizeEvent({
    id: copyId(r.id), ...r.event, repeat: 'none', cal, exdates: [],
    reminds: r.event.start ? [state.settings.defaultRemind] : [],
    invite: { id: r.id, owner: r.owner, ownerName: r.owner_name },
  });
}

function reconcileIncoming() {
  let changed = false;
  const seen = copiesSeen();
  for (const r of inv.incoming) {
    const copy = findEvent(copyId(r.id));
    if (copy) rememberCopy(r.id);
    if (r.status === 'accepted' && !copy) {
      if (seen.has(r.id)) {
        // Копию удалили сами — значит, передумали: сообщаем другу
        sync.client.rpc('answer_invite', { p_id: r.id, p_status: 'declined' }).then(() => { r.status = 'declined'; });
        rememberCopy(r.id, false);
      } else {
        state.events.push(makeCopy(r)); // приняли в другом месте (Telegram, push)
        rememberCopy(r.id);
        changed = true;
      }
    } else if (copy && r.status === 'cancelled' && !copy.invite?.cancelled) {
      copy.invite = { ...copy.invite, cancelled: true };
      copy.title = `Отменено: ${copy.title}`;
      copy.reminds = [];
      toast(`${r.owner_name || 'Друг'} отменил «${r.event.title}»`, { duration: 8000 });
      changed = true;
    } else if (copy && r.status === 'accepted' && !copy.invite?.cancelled && !sameSnapshot(inviteSnapshot(copy), { ...r.event, notes: copy.notes })) {
      Object.assign(copy, { title: r.event.title, date: r.event.date, endDate: r.event.endDate || null, start: r.event.start || null, end: r.event.end || null });
      toast(`«${r.event.title}» перенесли: ${inviteWhenText(r.event)}`, { duration: 8000 });
      changed = true;
    }
  }
  if (changed) saveEvents();
}

/** Владелец изменил или удалил событие — обновляем приглашения (друзья получат уведомление). */
function scheduleOwnerReconcile() {
  clearTimeout(inv.reconcileTimer);
  inv.reconcileTimer = setTimeout(reconcileOwner, 1500);
}

async function reconcileOwner() {
  if (!sync.client || !sync.user || !inv.loaded) return;
  for (const r of inv.mine) {
    if (r.status === 'cancelled') continue;
    const ev = findEvent(r.event_id);
    if (!ev || ev.repeat !== 'none') {
      const { error } = await sync.client.from('invites').update({ status: 'cancelled' }).eq('id', r.id);
      if (!error) r.status = 'cancelled';
    } else if (!sameSnapshot(inviteSnapshot(ev), r.event)) {
      const event = inviteSnapshot(ev);
      const { error } = await sync.client.from('invites').update({ event }).eq('id', r.id);
      if (!error) r.event = event;
    }
  }
}

/* ---------- Окно события: кого пригласить ---------- */

let pickedInvitees = new Set();

const invitesOf = (eventId) => inv.mine.filter((r) => r.event_id === eventId);

/** Поле «👥 Пригласить» в окне события. */
function renderInviteField(ev, preset = []) {
  const box = $('#fInviteWrap');
  const people = sync.user ? friendPeople() : [];
  const repeat = $('#fRepeat').value !== 'none';
  box.hidden = !people.length || Boolean(ev?.invite) || inv.missing;
  if (box.hidden) return;
  const rows = ev?.id ? invitesOf(ev.id) : [];
  if (!$('#fInvite').dataset.ready) {
    pickedInvitees = new Set([...rows.filter((r) => r.status !== 'cancelled').map((r) => r.invitee), ...preset]);
  }
  $('#fInvite').dataset.ready = '1';
  $('#fInvite').replaceChildren(...people.map((p) => {
    const r = rows.find((x) => x.invitee === p.id && x.status !== 'cancelled');
    return h('button', {
      class: 'remind-chip invite-chip',
      type: 'button',
      'aria-pressed': String(pickedInvitees.has(p.id)),
      disabled: repeat,
      onclick: () => {
        if (pickedInvitees.has(p.id)) pickedInvitees.delete(p.id);
        else pickedInvitees.add(p.id);
        renderInviteField(ev);
      },
    }, p.name, r ? h('small', { class: `invite-status is-${r.status}` }, ` · ${STATUS_LABEL[r.status]}`) : null);
  }));
  $('#fInviteHint').textContent = repeat
    ? 'Приглашать можно на разовые события — у повторяющихся отключено.'
    : 'Друзья получат приглашение «Приду / Может быть / Не смогу» — и уведомление.';
}

function resetInviteField() {
  delete $('#fInvite').dataset.ready;
  pickedInvitees = new Set();
}

/** После сохранения события: разослать новые приглашения, отменить снятые, обновить остальные. */
async function saveEventInvites(ev) {
  if (!sync.client || !sync.user || $('#fInviteWrap').hidden || ev.repeat !== 'none') return;
  const people = new Map(friendPeople().map((p) => [p.id, p.name]));
  const rows = invitesOf(ev.id);
  const event = inviteSnapshot(ev);
  const jobs = [];
  for (const id of pickedInvitees) {
    const r = rows.find((x) => x.invitee === id);
    if (!r) {
      jobs.push(sync.client.from('invites').insert({
        owner: sync.user.id, invitee: id, event_id: ev.id, owner_name: myShareName(), invitee_name: people.get(id) || '', event,
      }).select().single().then(({ data, error }) => { if (error) throw error; inv.mine.push(data); }));
    } else if (r.status === 'cancelled') {
      jobs.push(sync.client.from('invites').update({ status: 'pending', event }).eq('id', r.id).then(({ error }) => {
        if (error) throw error;
        Object.assign(r, { status: 'pending', event });
      }));
    }
  }
  for (const r of rows) {
    if (r.status !== 'cancelled' && !pickedInvitees.has(r.invitee)) {
      jobs.push(sync.client.from('invites').update({ status: 'cancelled' }).eq('id', r.id).then(({ error }) => {
        if (error) throw error;
        r.status = 'cancelled';
      }));
    }
  }
  const results = await Promise.allSettled(jobs);
  const failed = results.find((x) => x.status === 'rejected');
  if (failed) toast(`Не все приглашения отправлены: ${failed.reason?.message || failed.reason}`, { duration: 8000 });
  else if (jobs.length) toast('Приглашения отправлены');
  scheduleOwnerReconcile();
  render();
}

/** «👥 2/3» на событии: сколько друзей придёт из приглашённых. */
function inviteBadge(ev) {
  if (ev.friend) return null;
  const rows = inv.mine.filter((r) => r.event_id === ev.id && r.status !== 'cancelled');
  if (!rows.length) return null;
  const yes = rows.filter((r) => r.status === 'accepted').length;
  return h('span', { class: 'ev-progress invite-badge', title: rows.map((r) => `${r.invitee_name || 'Друг'} — ${STATUS_LABEL[r.status]}`).join('\n') }, `👥${yes}/${rows.length}`);
}

/* ---------- Приглашённый: карточка, ответ, события в календаре ---------- */

const openIncoming = () => inv.incoming.filter((r) => (r.status === 'pending' || r.status === 'maybe') && !findEvent(copyId(r.id)));

/** Неотвеченные приглашения — пунктиром в календаре, пока не ответите. */
function inviteEvents() {
  return openIncoming().map((r) => ({
    ...normalizeEvent({ id: `inv/${r.id}`, ...r.event, repeat: 'none', cal: 'inv' }),
    friend: 'inv', cal: 'inv', inviteId: r.id, title: `📨 ${r.status === 'maybe' ? '? ' : ''}${r.event.title}`, reminds: [],
  }));
}

/** Строки в разделе «Друзья»: приглашения на события. */
function inviteRows() {
  return openIncoming().map((r) => h('button', { class: 'invite-row event-invite', type: 'button', onclick: () => openInviteCard(r.id) },
    h('span', {}, '📨 ', h('strong', {}, r.owner_name || 'Друг'), ` зовёт: ${r.event.title}`),
    h('small', {}, `${inviteWhenText(r.event)}${r.status === 'maybe' ? ' · вы ответили «может быть»' : ''}`)));
}

let cardInvite = null;
let cardCal = null;

function openInviteCard(id) {
  const r = inv.incoming.find((x) => x.id === id);
  if (!r) return toast('Приглашение не найдено — возможно, его отменили');
  cardInvite = r;
  cardCal = findEvent(copyId(r.id))?.cal || defaultCal();
  $('#icTitle').textContent = r.event.title;
  $('#icWhen').textContent = inviteWhenText(r.event);
  $('#icFrom').textContent = `${r.owner_name || 'Друг'} приглашает${r.status !== 'pending' ? ` · ваш ответ: ${{ accepted: 'приду', maybe: 'может быть', declined: 'не смогу', cancelled: 'приглашение отменено' }[r.status]}` : ''}`;
  $('#icNotes').textContent = r.event.notes || '';
  $('#icNotes').hidden = !r.event.notes;
  renderCardCals();
  $('#icActions').hidden = r.status === 'cancelled';
  $('#inviteCard').showModal();
}

function renderCardCals() {
  $('#icCal').replaceChildren(...state.calendars.map((c) => h('button', {
    class: 'cal-chip', type: 'button', role: 'radio', 'aria-checked': String(c.id === cardCal), style: { '--c': c.color },
    onclick: () => { cardCal = c.id; renderCardCals(); },
  }, c.name)));
}

async function answerEventInvite(status) {
  const r = cardInvite;
  if (!r) return;
  const { error } = await sync.client.rpc('answer_invite', { p_id: r.id, p_status: status });
  if (error) return toast(`Не получилось ответить: ${error.message}`, { duration: 8000 });
  r.status = status;
  const copy = findEvent(copyId(r.id));
  if (status === 'accepted') {
    if (copy) copy.cal = cardCal;
    else state.events.push(makeCopy(r, cardCal));
    rememberCopy(r.id);
  } else if (copy) {
    state.events = state.events.filter((e) => e !== copy);
    rememberCopy(r.id, false);
  }
  saveEvents();
  $('#inviteCard').close();
  toast({ accepted: `«${r.event.title}» — в вашем календаре`, maybe: 'Ответили «может быть»', declined: 'Отказ отправлен' }[status]);
}

function initInvites() {
  // Пришло уведомление о приглашении, пока календарь открыт, — обновляем
  navigator.serviceWorker?.addEventListener('message', (e) => {
    if (e.data?.type === 'alarm' && e.data.alarm?.kind === 'invite') loadInvites().then(render);
  });
  $('#icYes').addEventListener('click', () => answerEventInvite('accepted'));
  $('#icMaybe').addEventListener('click', () => answerEventInvite('maybe'));
  $('#icNo').addEventListener('click', () => answerEventInvite('declined'));
  // Открыли календарь нажатием на уведомление о приглашении: ?invite=<id>
  const params = new URLSearchParams(location.search);
  const id = params.get('invite');
  if (id) {
    params.delete('invite');
    history.replaceState(null, '', `${location.pathname}${params.toString() ? `?${params}` : ''}`);
    const open = async () => {
      if (!inv.loaded) await loadInvites();
      openInviteCard(id);
    };
    const wait = setInterval(() => { if (sync.user) { clearInterval(wait); open(); } }, 500);
    setTimeout(() => clearInterval(wait), 15000);
  }
}
