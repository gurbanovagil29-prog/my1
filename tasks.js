'use strict';

/*
 * Задачи: хранение, отображение в календаре, раздел «Задачи» и редакторы.
 * Подключается до app.js и пользуется его помощниками (state, h, calOf…) только во время вызова.
 */

/* global HOUR_H, state, h, $, readJSON, writeJSON, uid, calOf, colorOf, defaultCal, findEvent, render, toast, withUndo,
   relativeDay, formatDate, capitalize, makeDraggable, openNav, closeNav, editing, CALS_KEY, saveEvents,
   toKey, fromKey, today, addDays, startOfWeek, toMin, fromMin, collect, taskDeadline, normalizeTask, WD_SHORT */

const TASKS_KEY = 'everyday-calendar:tasks';

const loadTasks = () => (readJSON(TASKS_KEY, []) || []).map(normalizeTask).filter(Boolean);

function saveTasks() {
  if (!writeJSON(TASKS_KEY, state.tasks)) toast('Не удалось сохранить: хранилище браузера недоступно');
  render();
}

const findTask = (id) => state.tasks.find((t) => t.id === id);
const visibleTasks = () => state.tasks.filter((t) => calOf(t).visible);
const deadlineOf = (task) => taskDeadline(task, task.eventId ? findEvent(task.eventId) : null);

/** Момент срока: время, а без времени — конец дня. */
function deadlineMoment(dl) {
  const d = fromKey(dl.date);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, dl.time ? toMin(dl.time) : 1440);
}

function isOverdue(task) {
  if (task.done) return false;
  const dl = deadlineOf(task);
  return Boolean(dl) && deadlineMoment(dl) < new Date();
}

function compareTasks(a, b) {
  const da = deadlineOf(a);
  const db = deadlineOf(b);
  return (a.done - b.done)
    || (b.priority - a.priority)
    || ((da?.date || '9999') + (da?.time || '99')).localeCompare((db?.date || '9999') + (db?.time || '99'))
    || a.title.localeCompare(b.title, 'ru');
}

/**
 * Видимые задачи по дате срока за период: Map<'YYYY-MM-DD', [task]>.
 * standalone — без задач, привязанных к событию: в сетке календаря их показывает прогресс «✓2/5» на самом событии.
 */
function tasksByDay(from, to, { standalone = false } = {}) {
  const map = new Map();
  const a = toKey(from);
  const b = toKey(to);
  for (const t of visibleTasks()) {
    if (standalone && t.eventId && findEvent(t.eventId)) continue;
    const dl = deadlineOf(t);
    if (!dl || dl.date < a || dl.date > b) continue;
    if (!map.has(dl.date)) map.set(dl.date, []);
    map.get(dl.date).push(t);
  }
  for (const list of map.values()) list.sort(compareTasks);
  return map;
}

/** Задачи, привязанные к событию (для повторяющегося — к конкретному дню). */
const linkedTasks = (ev, key) => state.tasks.filter((t) => t.eventId === ev.id && (ev.repeat === 'none' || t.eventKey === key));

/** Отвязывает задачи от события, сохраняя их текущий срок (например, перед удалением события). */
function detachTasks(evId, match = () => true) {
  for (const t of state.tasks) {
    if (t.eventId !== evId || !match(t)) continue;
    const dl = deadlineOf(t);
    Object.assign(t, { due: dl?.date || null, time: dl?.time || null, eventId: null, eventKey: null });
  }
}

function deadlineLabel(dl) {
  const d = fromKey(dl.date);
  return `${relativeDay(d) || formatDate(d)}${dl.time ? `, ${dl.time}` : ''}`;
}

function overdueLabel(dl) {
  const days = Math.round((today() - fromKey(dl.date)) / 86400000);
  return days > 0 ? `просрочено на ${days} ${plural(days, 'день', 'дня', 'дней')}` : 'срок прошёл';
}

function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/* ---------- Отметка «выполнено» ---------- */

function toggleTask(id) {
  const t = findTask(id);
  if (!t) return;
  t.done = !t.done;
  t.doneAt = t.done ? Date.now() : null;
  saveTasks();
  if (!t.done) return;
  const ev = t.eventId && findEvent(t.eventId);
  const siblings = ev ? linkedTasks(ev, t.eventKey) : [];
  if (siblings.length > 1 && siblings.every((x) => x.done)) toast(`Всё готово к «${ev.title}» 🎉`);
  else toast(`Готово: ${t.title}`, { action: 'Вернуть', onAction: () => toggleTask(id) });
}

function taskCheck(task) {
  return h('button', {
    class: `task-check${task.done ? ' is-done' : ''}`,
    type: 'button',
    role: 'checkbox',
    'aria-checked': String(task.done),
    'aria-label': `${task.done ? 'Вернуть' : 'Выполнить'}: ${task.title}`,
    style: { '--c': colorOf(task) },
    onclick: (e) => { e.stopPropagation(); toggleTask(task.id); },
  });
}

/** Прогресс задач события: «✓ 2/5». */
function progressBadge(ev, key) {
  const list = linkedTasks(ev, key);
  if (!list.length) return null;
  const done = list.filter((t) => t.done).length;
  return h('span', {
    class: `ev-progress${done === list.length ? ' is-complete' : ''}`,
    title: `Задачи к событию: выполнено ${done} из ${list.length}`,
  }, `✓${done}/${list.length}`);
}

/* ---------- Задачи в календаре ---------- */

function taskClasses(task, base) {
  return `${base}${task.done ? ' is-done' : ''}${isOverdue(task) ? ' is-overdue' : ''}${task.priority ? ' is-important' : ''}`;
}

function taskTooltip(task) {
  const dl = deadlineOf(task);
  const ev = task.eventId && findEvent(task.eventId);
  return [`☑ ${task.title}`, dl ? `Срок: ${deadlineLabel(dl)}` : 'Без срока', ev ? `К событию: ${ev.title}` : null, calOf(task).name]
    .filter(Boolean).join('\n');
}

/** Задача в клетке месяца и в строке «весь день». */
function taskChip(task) {
  const dl = deadlineOf(task);
  const el = h('div', {
    class: taskClasses(task, 'chip is-task'),
    role: 'button',
    tabindex: '0',
    style: { '--c': colorOf(task) },
    title: taskTooltip(task),
    onclick: (e) => { e.stopPropagation(); openTaskEditor(task); },
    onkeydown: (e) => { if (e.key === 'Enter') { e.stopPropagation(); openTaskEditor(task); } },
  },
  taskCheck(task),
  dl?.time ? h('span', { class: 'chip-time' }, dl.time) : null,
  h('span', { class: 'chip-title' }, task.title));
  makeTaskDraggable(el, task);
  return el;
}

/** Флажок срока на сетке времени. */
function deadlineMarker(task) {
  const dl = deadlineOf(task);
  return h('div', {
    class: taskClasses(task, 'tg-deadline'),
    style: { '--c': colorOf(task), top: `${(toMin(dl.time) / 60) * HOUR_H}px` },
  }, h('div', {
    class: 'tg-deadline-pill',
    role: 'button',
    tabindex: '0',
    title: taskTooltip(task),
    onclick: (e) => { e.stopPropagation(); openTaskEditor(task); },
    onkeydown: (e) => { if (e.key === 'Enter') openTaskEditor(task); },
  }, taskCheck(task), h('span', {}, `⚑ ${dl.time} ${task.title}`)));
}

/** Строка задачи в боковой панели, панели дня и списке. */
function taskLine(task, { showDate = false } = {}) {
  const dl = deadlineOf(task);
  const meta = [];
  if (showDate && dl) meta.push(isOverdue(task) ? overdueLabel(dl) : deadlineLabel(dl));
  else if (dl?.time) meta.push(`до ${dl.time}`);
  const ev = task.eventId && findEvent(task.eventId);
  if (ev) meta.push(`к «${ev.title}»`);
  return h('div', { class: taskClasses(task, 'task-line'), style: { '--c': colorOf(task) } },
    taskCheck(task),
    h('button', { class: 'task-line-main', type: 'button', onclick: () => { openTaskEditor(task); closeNav(); } },
      h('span', { class: 'task-line-title' }, task.title),
      meta.length ? h('small', {}, meta.join(' · ')) : null));
}

function makeTaskDraggable(el, task) {
  if (task.eventId) return; // срок задачи у события меняется вместе с событием
  makeDraggable(el, { id: task.id, repeat: 'none', start: null, kind: 'task' });
}

/** Перенос задачи на другой день (вызывается из dropTarget в app.js). */
function moveTask(id, key) {
  const t = findTask(id);
  if (!t || t.due === key) return;
  withUndo(`Срок перенесён: ${deadlineLabel({ date: key, time: t.time })}`, () => { t.due = key; });
}

/* ---------- Раздел «Задачи» ---------- */

function renderTasksView() {
  const t = today();
  const tk = toKey(t);
  const tomorrow = toKey(addDays(t, 1));
  const weekEnd = toKey(addDays(startOfWeek(t), 6));
  const groups = {
    overdue: { title: 'Просрочено', cls: 'is-overdue', items: [] },
    today: { title: 'Сегодня', items: [] },
    tomorrow: { title: 'Завтра', items: [] },
    week: { title: 'До конца недели', items: [] },
    later: { title: 'Позже', items: [] },
    nodate: { title: 'Без срока', items: [] },
    done: { title: 'Выполнено', items: [] },
  };
  for (const task of visibleTasks()) {
    const dl = deadlineOf(task);
    let g;
    if (task.done) g = 'done';
    else if (!dl) g = 'nodate';
    else if (isOverdue(task)) g = 'overdue';
    else if (dl.date === tk) g = 'today';
    else if (dl.date === tomorrow) g = 'tomorrow';
    else if (dl.date <= weekEnd) g = 'week';
    else g = 'later';
    groups[g].items.push(task);
  }
  for (const g of Object.values(groups)) g.items.sort(compareTasks);
  groups.done.items.sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));

  // Прогресс дня: задачи со сроком сегодня, включая уже выполненные сегодня
  const todayAll = visibleTasks().filter((x) => deadlineOf(x)?.date === tk);
  const todayDone = todayAll.filter((x) => x.done).length;
  const open = visibleTasks().filter((x) => !x.done).length;

  const wrap = h('div', { class: 'tasks' });
  wrap.append(h('div', { class: 'tasks-summary' },
    h('div', { class: 'tasks-stat' }, h('b', {}, open), plural(open, 'открытая', 'открытые', 'открытых')),
    h('div', { class: `tasks-stat${groups.overdue.items.length ? ' is-overdue' : ''}` }, h('b', {}, groups.overdue.items.length), 'просрочено'),
    h('div', { class: 'tasks-today' },
      h('span', {}, todayAll.length ? `Сегодня: ${todayDone} из ${todayAll.length}` : 'На сегодня задач нет'),
      h('div', { class: 'progress' }, h('div', { style: { width: `${todayAll.length ? (todayDone / todayAll.length) * 100 : 0}%` } })))));

  for (const [id, g] of Object.entries(groups)) {
    if (!g.items.length) continue;
    const rows = g.items.map((task) => taskRow(task, id));
    if (id === 'done') {
      const details = h('details', { class: 'task-group is-done-group', open: state.settings.showDone ? true : null },
        h('summary', { class: 'task-group-title' }, g.title, h('span', { class: 'count' }, g.items.length)), rows.slice(0, 50));
      details.addEventListener('toggle', () => { state.settings.showDone = details.open; writeJSON('everyday-calendar:settings', state.settings); });
      wrap.append(details);
    } else {
      wrap.append(h('section', { class: `task-group ${g.cls || ''}` },
        h('h3', { class: 'task-group-title' }, g.title, h('span', { class: 'count' }, g.items.length)), rows));
    }
  }

  if (!state.tasks.length) {
    wrap.append(h('div', { class: 'empty' },
      h('strong', {}, 'Задач пока нет'),
      'Напишите в строке сверху, например: «сдать отчёт до пятницы 18:00 #работа !».',
      h('br'), 'Задачи к встрече удобно добавлять прямо в окне события.'));
  } else if (!visibleTasks().length) {
    wrap.append(h('div', { class: 'empty' }, h('strong', {}, 'Все задачи в скрытых календарях'), 'Включите нужные календари слева.'));
  }
  return wrap;
}

function taskRow(task, group) {
  const dl = deadlineOf(task);
  const ev = task.eventId && findEvent(task.eventId);
  const meta = [];
  if (dl) {
    if (group === 'overdue') meta.push(h('span', { class: 'task-overdue' }, `${overdueLabel(dl)} · ${deadlineLabel(dl)}`));
    else if (group === 'today') meta.push(dl.time ? `до ${dl.time}` : 'в течение дня');
    else meta.push(deadlineLabel(dl));
  }
  if (ev) meta.push(h('span', { class: 'task-event' }, `📅 ${ev.title}`));
  if (task.notes) meta.push(h('span', { class: 'task-notes' }, task.notes.split('\n')[0]));
  return h('div', { class: taskClasses(task, 'task-row'), style: { '--c': colorOf(task) } },
    taskCheck(task),
    h('button', { class: 'task-main', type: 'button', onclick: () => openTaskEditor(task) },
      h('span', { class: 'task-title' }, task.priority ? h('span', { class: 'task-flag', title: 'Важная' }, '!') : null, task.title),
      meta.length ? h('span', { class: 'task-meta' }, meta.flatMap((m, i) => (i ? [' · ', m] : [m]))) : null),
    h('span', { class: 'task-cal', title: calOf(task).name }, calOf(task).name));
}

/** Число на вкладке «Задачи»: просроченные и на сегодня. */
function taskBadgeCount() {
  const tk = toKey(today());
  return visibleTasks().filter((t) => !t.done && (isOverdue(t) || deadlineOf(t)?.date === tk)).length;
}

/* ---------- Редактор задачи ---------- */

let editingTask = null;
let pickedTaskCal = null;

function renderTaskCalPicker() {
  $('#tCal').replaceChildren(...state.calendars.map((c) => h('button', {
    class: 'cal-chip',
    type: 'button',
    role: 'radio',
    'aria-checked': String(c.id === pickedTaskCal),
    style: { '--c': c.color },
    onclick: () => { pickedTaskCal = c.id; renderTaskCalPicker(); },
  }, c.name)));
}

/** Варианты привязки: вхождения событий за неделю назад и два месяца вперёд. */
function eventOptions(current) {
  const t = today();
  const opts = [h('option', { value: '' }, 'Без события — свой срок')];
  let found = false;
  for (const [key, list] of collect(state.events, addDays(t, -7), addDays(t, 60))) {
    for (const { ev } of list) {
      const value = `${ev.id}|${ev.repeat === 'none' ? '' : key}`;
      if (value === current) found = true;
      opts.push(h('option', { value }, `${capitalize(formatDate(fromKey(key)))}${ev.start ? `, ${ev.start}` : ''} · ${ev.title}`));
    }
  }
  if (current && !found) {
    const [id, key] = current.split('|');
    const ev = findEvent(id);
    if (ev) opts.splice(1, 0, h('option', { value: current }, `${capitalize(formatDate(fromKey(key || ev.date)))} · ${ev.title}`));
  }
  return opts;
}

function syncTaskLink() {
  const value = $('#tEvent').value;
  const linked = Boolean(value);
  $('#tDueRow').hidden = linked;
  $('#tLinkedHint').hidden = !linked;
  if (!linked) return;
  const [id, key] = value.split('|');
  const ev = findEvent(id);
  if (!ev) return;
  const dl = taskDeadline({ eventId: id, eventKey: key || null }, ev);
  $('#tLinkedHint').textContent = `Срок — начало события: ${deadlineLabel(dl)}. Перенесёте событие — срок сдвинется вместе с ним.`;
}

function openTaskEditor(task = null, preset = {}) {
  closeNav();
  editingTask = task ? task.id : null;
  const v = task || {
    title: preset.title || '',
    due: preset.due || null,
    time: preset.time || null,
    cal: preset.cal || defaultCal(),
    priority: preset.priority || 0,
    eventId: preset.eventId || null,
    eventKey: preset.eventKey || null,
    notes: '',
  };
  $('#tTitle').value = v.title;
  $('#tDue').value = v.due || '';
  $('#tTime').value = v.time || '';
  $('#tPriority').checked = Boolean(v.priority);
  $('#tNotes').value = v.notes || '';
  const link = v.eventId ? `${v.eventId}|${v.eventKey || ''}` : '';
  $('#tEvent').replaceChildren(...eventOptions(link));
  $('#tEvent').value = link;
  pickedTaskCal = calOf(v).id;
  renderTaskCalPicker();
  $('#btnDeleteTask').hidden = !task;
  syncTaskLink();
  $('#taskEditor').showModal();
  $('#tTitle').focus();
}

function initTasks() {
  $('#tEvent').addEventListener('change', () => {
    syncTaskLink();
    const ev = findEvent($('#tEvent').value.split('|')[0]);
    if (ev) { pickedTaskCal = calOf(ev).id; renderTaskCalPicker(); }
  });

  $('#taskForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const [eventId, eventKey] = $('#tEvent').value.split('|');
    const data = {
      title: $('#tTitle').value.trim() || 'Без названия',
      due: eventId ? null : ($('#tDue').value || null),
      time: eventId ? null : ($('#tTime').value || null),
      cal: pickedTaskCal,
      priority: $('#tPriority').checked ? 1 : 0,
      eventId: eventId || null,
      eventKey: eventKey || null,
      notes: $('#tNotes').value.trim(),
    };
    if (data.time && !data.due) data.due = toKey(today());
    if (eventId) {
      // Запоминаем срок на случай, если событие потом удалят
      const dl = deadlineOf(data);
      data.due = dl?.date || null;
      data.time = dl?.time || null;
    }
    const cal = state.calendars.find((c) => c.id === data.cal);
    if (cal && !cal.visible) { cal.visible = true; writeJSON(CALS_KEY, state.calendars); }
    const task = editingTask && findTask(editingTask);
    if (task) withUndo('Задача сохранена', () => Object.assign(task, data));
    else {
      state.tasks.push({ id: uid(), done: false, doneAt: null, ...data });
      saveTasks();
      toast(`Задача добавлена: ${data.title}`);
    }
    $('#taskEditor').close();
  });

  $('#btnDeleteTask').addEventListener('click', () => {
    const task = findTask(editingTask);
    $('#taskEditor').close();
    if (task) withUndo('Задача удалена', () => { state.tasks = state.tasks.filter((t) => t.id !== task.id); });
  });

  // Чек-лист в окне события
  $('#evTaskInput').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const title = e.target.value.trim();
    if (!title) return;
    e.target.value = '';
    const ev = editing.id && findEvent(editing.id);
    if (ev) {
      const key = ev.repeat === 'none' ? null : editing.key;
      const dl = taskDeadline({ eventId: ev.id, eventKey: key }, ev);
      state.tasks.push({
        id: uid(), title, due: dl.date, time: dl.time, cal: calOf(ev).id, priority: 0,
        done: false, doneAt: null, eventId: ev.id, eventKey: key, notes: '',
      });
      saveTasks();
    } else {
      editing.pendingTasks.push({ id: uid(), title, done: false });
    }
    renderEvTasks();
  });
}

/** Список задач в окне события. Для нового события задачи копятся и создаются при сохранении. */
function renderEvTasks() {
  const ev = editing.id && findEvent(editing.id);
  const list = ev ? linkedTasks(ev, editing.key).sort(compareTasks) : editing.pendingTasks;
  $('#evTasks').replaceChildren(...list.map((t) => h('div', { class: `ev-task${t.done ? ' is-done' : ''}` },
    h('button', {
      class: `task-check${t.done ? ' is-done' : ''}`,
      type: 'button',
      role: 'checkbox',
      'aria-checked': String(t.done),
      'aria-label': t.title,
      onclick: () => {
        if (ev) toggleTask(t.id);
        else t.done = !t.done;
        renderEvTasks();
      },
    }),
    h('span', {}, t.title),
    h('button', {
      class: 'ev-task-remove',
      type: 'button',
      'aria-label': `Удалить задачу ${t.title}`,
      onclick: () => {
        if (ev) {
          state.tasks = state.tasks.filter((x) => x.id !== t.id);
          saveTasks();
        } else {
          editing.pendingTasks = editing.pendingTasks.filter((x) => x !== t);
        }
        renderEvTasks();
      },
    }, '✕'))));
}

/** Создаёт задачи, набранные в окне нового события. */
function commitPendingTasks(ev) {
  for (const p of editing.pendingTasks) {
    state.tasks.push({
      id: p.id, title: p.title, due: ev.date, time: ev.start, cal: ev.cal, priority: 0,
      done: p.done, doneAt: p.done ? Date.now() : null, eventId: ev.id, eventKey: ev.repeat === 'none' ? null : ev.date, notes: '',
    });
  }
  editing.pendingTasks = [];
  writeJSON(TASKS_KEY, state.tasks);
}
