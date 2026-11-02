'use strict';

/*
 * Скрытые заметки: открываются неприметной строкой «Версия …» внизу меню. Свободный текст без ограничений,
 * сохраняется сам — на устройстве сразу, в аккаунте через секунду после последней правки (таблица memos,
 * supabase/update-4.sql: видна только владельцу, друзьям и серверу напоминаний не отдаётся).
 * Если текст меняли на двух устройствах, пока они не видели друг друга, ничего не теряется:
 * версия с другого устройства дописывается ниже.
 */

/* global sync, $, closeNav */

const MEMO_KEY = 'everyday-calendar:memo';
const memo = { timer: null, server: 'unknown', saving: null };

/** { text, at — когда правили здесь, synced — какую версию аккаунта видели последней } */
function readMemo() {
  try {
    const m = JSON.parse(localStorage.getItem(MEMO_KEY) || 'null');
    return m && typeof m.text === 'string' ? m : { text: '', at: 0, synced: 0 };
  } catch {
    return { text: '', at: 0, synced: 0 };
  }
}

function writeMemo(m) {
  try { localStorage.setItem(MEMO_KEY, JSON.stringify(m)); } catch { /* нет места — остаётся в окне до закрытия */ }
}

const memoText = () => readMemo().text;
const memoOnline = () => Boolean(sync.client && sync.user);

function setMemoStatus(text) {
  $('#memoStatus').textContent = text;
}

function memoStatusIdle() {
  const m = readMemo();
  const when = m.at ? new Date(m.at).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
  const where = !memoOnline() ? 'только на этом устройстве' : memo.server === 'missing' ? 'только здесь — в Supabase нет таблицы memos (update-4.sql)' : 'сохранено';
  setMemoStatus(when ? `${where} · ${when}` : where);
}

/** Сверить с аккаунтом: забрать новую версию или отправить свою. */
async function pullMemo() {
  if (!memoOnline()) return;
  const { data, error } = await sync.client.from('memos').select('text,updated_at').eq('user_id', sync.user.id).maybeSingle();
  if (error) { memo.server = 'missing'; return; }
  memo.server = 'ok';
  const m = readMemo();
  const remoteAt = data ? Date.parse(data.updated_at) : 0;
  const localDirty = m.at > (m.synced || 0);
  if (data && remoteAt > (m.synced || 0) && data.text !== m.text) {
    // Не менялось здесь — берём из аккаунта; менялось в обоих местах — дописываем ту версию ниже
    const text = localDirty && m.text ? `${m.text}\n\n— с другого устройства —\n${data.text}` : data.text;
    writeMemo({ text, at: localDirty ? Date.now() : remoteAt, synced: remoteAt });
    if ($('#memoDialog').open) $('#memoText').value = text;
    if (localDirty) await pushMemo();
  } else if (localDirty) {
    await pushMemo();
  }
}

async function pushMemo() {
  if (!memoOnline() || memo.server === 'missing') return;
  const m = readMemo();
  const updated = new Date(Math.max(m.at, Date.now())).toISOString();
  memo.saving = sync.client.from('memos').upsert({ user_id: sync.user.id, text: m.text, updated_at: updated }, { onConflict: 'user_id' });
  const { error } = await memo.saving;
  memo.saving = null;
  if (error) {
    memo.server = /memos/i.test(error.message) ? 'missing' : memo.server;
    setMemoStatus('не сохранилось в аккаунт — осталось на устройстве');
    return;
  }
  writeMemo({ ...readMemo(), synced: Date.parse(updated) });
}

function onMemoInput() {
  writeMemo({ ...readMemo(), text: $('#memoText').value, at: Date.now() });
  setMemoStatus('…');
  clearTimeout(memo.timer);
  memo.timer = setTimeout(async () => { memo.timer = null; await pushMemo(); memoStatusIdle(); }, 1000);
}

async function openMemo() {
  closeNav();
  $('#memoText').value = memoText();
  memoStatusIdle();
  $('#memoDialog').showModal();
  await pullMemo();
  memoStatusIdle();
}

function initMemo() {
  $('#btnMemo').addEventListener('click', openMemo);
  $('#memoText').addEventListener('input', onMemoInput);
  $('#memoDialog').addEventListener('close', () => {
    if (!memo.timer) return;
    clearTimeout(memo.timer);
    memo.timer = null;
    pushMemo();
  });
}
