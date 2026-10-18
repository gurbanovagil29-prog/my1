'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSyncEngine, stableStringify } = require('../sync.js');
const { normalizeEvent, normalizeTask } = require('../core.js');

/** Сервер в памяти. Как Postgres (jsonb), хранит ключи объекта в другом порядке. */
function fakeServer() {
  const rows = new Map();
  let clock = Date.UTC(2026, 9, 18, 10, 0, 0);
  const reorder = (o) => (o ? Object.fromEntries(Object.entries(o).reverse()) : o);
  return {
    rows,
    offline: false,
    async pull(since) {
      if (this.offline) throw new Error('offline');
      const from = since ? Date.parse(since) - 5000 : -Infinity;
      return [...rows.values()].filter((r) => Date.parse(r.updated_at) >= from)
        .sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at))
        .map((r) => structuredClone(r));
    },
    async push(list) {
      if (this.offline) throw new Error('offline');
      for (const r of list) {
        clock += 1000;
        rows.set(`${r.kind}:${r.id}`, { ...structuredClone(r), data: reorder(structuredClone(r.data)), updated_at: new Date(clock).toISOString() });
      }
    },
  };
}

const prepare = (kind, o) => {
  if (kind === 'event') return normalizeEvent(o);
  if (kind === 'task') return normalizeTask(o);
  const { visible, ...rest } = o;
  return rest;
};

/** Устройство: свои данные, своя «тень» синхронизации. */
function device(server) {
  const d = { event: [], task: [], calendar: [], stored: null, statuses: [] };
  d.engine = createSyncEngine({
    backend: server,
    readLocal: () => d,
    applyRemote: (ch) => {
      for (const kind of ['event', 'task', 'calendar']) {
        const byId = new Map(d[kind].map((x) => [x.id, x]));
        for (const id of ch[kind].del) byId.delete(id);
        for (const o of ch[kind].set) {
          const prev = byId.get(o.id);
          byId.set(o.id, kind === 'calendar' ? { ...o, visible: prev ? prev.visible : true } : prepare(kind, o));
        }
        d[kind] = [...byId.values()];
      }
    },
    prepare,
    store: { get: () => d.stored, set: (v) => { d.stored = structuredClone(v); } },
    onStatus: (s) => d.statuses.push(s),
  });
  return d;
}

const ev = (id, title, extra = {}) => normalizeEvent({ id, title, date: '2026-10-20', start: '10:00', end: '11:00', ...extra });
const titles = (d) => d.event.map((e) => e.title).sort();

test('событие с телефона появляется на компьютере', async () => {
  const server = fakeServer();
  const phone = device(server);
  const pc = device(server);
  phone.event.push(ev('a', 'Встреча'));
  await phone.engine.sync();
  await pc.engine.sync();
  assert.deepEqual(titles(pc), ['Встреча']);
});

test('повторная синхронизация ничего не отправляет (порядок ключей jsonb не важен)', async () => {
  const server = fakeServer();
  const phone = device(server);
  phone.event.push(ev('a', 'Встреча'));
  phone.task.push(normalizeTask({ id: 't', title: 'Отчёт', due: '2026-10-23' }));
  await phone.engine.sync();
  const r = await phone.engine.sync();
  assert.equal(r.pushed, 0);
  assert.equal(r.applied, false);
});

test('изменения и удаления доходят в обе стороны', async () => {
  const server = fakeServer();
  const phone = device(server);
  const pc = device(server);
  phone.event.push(ev('a', 'Встреча'), ev('b', 'Обед'));
  await phone.engine.sync();
  await pc.engine.sync();

  pc.event.find((e) => e.id === 'a').title = 'Встреча с Аней';
  phone.event = phone.event.filter((e) => e.id !== 'b');
  await pc.engine.sync();
  await phone.engine.sync();
  await pc.engine.sync();

  assert.deepEqual(titles(phone), ['Встреча с Аней']);
  assert.deepEqual(titles(pc), ['Встреча с Аней']);
  assert.equal(server.rows.get('event:b').deleted, true);
});

test('данные двух устройств объединяются при первом входе', async () => {
  const server = fakeServer();
  const phone = device(server);
  const pc = device(server);
  phone.event.push(ev('p', 'С телефона'));
  pc.event.push(ev('c', 'С компьютера'));
  await phone.engine.sync();
  await pc.engine.sync();
  await phone.engine.sync();
  assert.deepEqual(titles(phone), ['С компьютера', 'С телефона']);
  assert.deepEqual(titles(pc), ['С компьютера', 'С телефона']);
});

test('правка без сети не теряется и уходит позже', async () => {
  const server = fakeServer();
  const phone = device(server);
  const pc = device(server);
  phone.event.push(ev('a', 'Встреча'));
  await phone.engine.sync();
  await pc.engine.sync();

  server.offline = true;
  phone.event[0].title = 'Встреча (перенесли)';
  await phone.engine.sync();
  assert.equal(phone.statuses.at(-1), 'error');
  assert.equal(phone.event[0].title, 'Встреча (перенесли)');

  server.offline = false;
  await phone.engine.sync();
  await pc.engine.sync();
  assert.deepEqual(titles(pc), ['Встреча (перенесли)']);
});

test('одновременная правка: локальная версия не затирается старой серверной', async () => {
  const server = fakeServer();
  const phone = device(server);
  const pc = device(server);
  phone.event.push(ev('a', 'v1'));
  await phone.engine.sync();
  await pc.engine.sync();

  pc.event[0].title = 'с компьютера';
  await pc.engine.sync();
  phone.event[0].title = 'с телефона';
  await phone.engine.sync(); // телефон сохранил позже — его версия побеждает
  await pc.engine.sync();
  assert.deepEqual(titles(phone), ['с телефона']);
  assert.deepEqual(titles(pc), ['с телефона']);
});

test('видимость календаря у каждого устройства своя', async () => {
  const server = fakeServer();
  const phone = device(server);
  const pc = device(server);
  phone.calendar.push({ id: 'work', name: 'Работа', color: '#4f6bed', visible: true });
  await phone.engine.sync();
  await pc.engine.sync();
  pc.calendar[0].visible = false;
  const r = await pc.engine.sync();
  assert.equal(r.pushed, 0);
  phone.calendar[0].name = 'Работа и проекты';
  await phone.engine.sync();
  await pc.engine.sync();
  assert.equal(pc.calendar[0].name, 'Работа и проекты');
  assert.equal(pc.calendar[0].visible, false);
});

test('stableStringify не зависит от порядка ключей', () => {
  assert.equal(stableStringify({ b: 1, a: [{ d: 2, c: 3 }] }), stableStringify({ a: [{ c: 3, d: 2 }], b: 1 }));
});
