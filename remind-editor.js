'use strict';

/*
 * Раздел «🔔 Напоминания» в окнах задачи и события: итог простыми словами сверху,
 * «до срока / до начала» кнопками (можно несколько и своё), «в точное время» выбором даты и времени,
 * а у задачи — «если не отметил(а)»: повтор с выбранным интервалом и, если нужно, только в эти часы.
 */

/* global h, zonedMs, localParts, userTz, dayLabel, beforeLabel */

const REMIND_PRESETS = [[0, 'В момент'], [5, '5 мин'], [10, '10 мин'], [15, '15 мин'], [30, '30 мин'], [60, '1 ч'], [120, '2 ч'], [1440, 'За день']];
const REPEAT_OPTIONS = [['', 'Не повторять'], ['5', 'Каждые 5 минут'], ['10', 'Каждые 10 минут'], ['15', 'Каждые 15 минут'], ['30', 'Каждые 30 минут'], ['60', 'Каждый час'], ['120', 'Каждые 2 часа']];

/** «сегодня в 13:00, 13:15 и 13:25, завтра в 9:00». */
function momentsText(list, now, tz) {
  const groups = [];
  for (const t of list) {
    const p = localParts(t, tz);
    const last = groups[groups.length - 1];
    if (last && last.key === p.key) last.hm.push(p.hm);
    else groups.push({ key: p.key, hm: [p.hm] });
  }
  const join = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} и ${xs[xs.length - 1]}` : xs[0]);
  return groups.map((g) => `${dayLabel(g.key, now, tz)} в ${join(g.hm)}`).join(', ');
}

/**
 * root — куда рисовать; opts: {
 *   kind: 'task' | 'event',
 *   anchor() → ms | null — от чего считать «за N минут» (срок или начало),
 *   anchorHint() → подпись, когда считать не от чего,
 *   summary(model) → текст итога,
 *   onChange(),
 * }
 */
function createRemindEditor(root, opts) {
  const model = { before: new Set(), at: [], every: null, window: null };
  const ui = { custom: false, exact: false };
  const isTask = opts.kind === 'task';
  const changed = () => { render(); opts.onChange?.(); };

  function chip(label, pressed, onclick, extra = {}) {
    return h('button', { class: 'remind-chip', type: 'button', 'aria-pressed': String(pressed), onclick, ...extra }, label);
  }

  function beforeSection() {
    const anchor = opts.anchor();
    const values = [...new Set([...REMIND_PRESETS.map(([m]) => m), ...model.before])].sort((a, b) => a - b);
    const label = (m) => REMIND_PRESETS.find(([x]) => x === m)?.[1] || beforeLabel(m);
    const num = h('input', { type: 'number', min: '1', max: '999', value: '20', inputmode: 'numeric', 'aria-label': 'Сколько' });
    const unit = h('select', { 'aria-label': 'Единица' }, h('option', { value: '1' }, 'минут'), h('option', { value: '60' }, 'часов'), h('option', { value: '1440' }, 'дней'));
    return h('div', { class: 'remind-sub' },
      h('small', {}, isTask ? 'До срока' : 'До начала'),
      h('div', { class: 'remind-chips' },
        values.map((m) => chip(label(m), model.before.has(m), () => {
          if (model.before.has(m)) model.before.delete(m);
          else model.before.add(m);
          changed();
        }, { disabled: anchor == null })),
        chip('Своё…', ui.custom, () => { ui.custom = !ui.custom; render(); }, { disabled: anchor == null })),
      anchor == null ? h('small', { class: 'muted' }, opts.anchorHint()) : null,
      ui.custom && anchor != null ? h('div', { class: 'remind-row' }, 'за', num, unit,
        h('button', {
          class: 'btn small', type: 'button',
          onclick: () => {
            const m = Math.round(+num.value * +unit.value);
            if (m > 0 && m <= 7 * 1440) { model.before.add(m); ui.custom = false; changed(); }
          },
        }, 'Добавить')) : null);
  }

  function exactSection() {
    const now = Date.now();
    const tz = userTz();
    const inHour = localParts(now + 3600000, tz);
    const date = h('input', { type: 'date', value: inHour.key, min: localParts(now, tz).key, 'aria-label': 'День' });
    const time = h('input', { type: 'time', value: `${inHour.hm.slice(0, 3)}00`, step: '300', 'aria-label': 'Время' });
    return h('div', { class: 'remind-sub' },
      h('small', {}, 'В точное время'),
      h('div', { class: 'remind-chips' },
        model.at.slice().sort((a, b) => a - b).map((t) => h('span', { class: `remind-chip is-on${t < now ? ' is-past' : ''}` },
          momentsText([t], now, tz),
          h('button', { type: 'button', 'aria-label': 'Убрать', onclick: () => { model.at = model.at.filter((x) => x !== t); changed(); } }, '✕'))),
        chip('＋ Добавить', ui.exact, () => { ui.exact = !ui.exact; render(); })),
      ui.exact ? h('div', { class: 'remind-row' }, date, time,
        h('button', {
          class: 'btn small', type: 'button',
          onclick: () => {
            if (!date.value || !time.value) return;
            const t = zonedMs(date.value, time.value, tz);
            if (!model.at.includes(t)) model.at.push(t);
            ui.exact = false;
            changed();
          },
        }, 'Добавить')) : null);
  }

  function repeatSection() {
    const every = h('select', { 'aria-label': 'Повторять' }, REPEAT_OPTIONS.map(([v, label]) => h('option', { value: v, selected: String(model.every || '') === v }, label)));
    every.addEventListener('change', () => { model.every = every.value ? +every.value : null; changed(); });
    const from = h('input', { type: 'time', value: model.window?.[0] || '', 'aria-label': 'С' });
    const to = h('input', { type: 'time', value: model.window?.[1] || '', 'aria-label': 'До' });
    const setWindow = () => { model.window = from.value && to.value && from.value < to.value ? [from.value, to.value] : null; changed(); };
    from.addEventListener('change', setWindow);
    to.addEventListener('change', setWindow);
    return h('div', { class: 'remind-sub' },
      h('small', {}, 'Если не отметил(а), что сделано'),
      every,
      model.every ? h('details', { class: 'remind-more', open: Boolean(model.window) },
        h('summary', {}, 'Ещё: только в определённые часы'),
        h('div', { class: 'remind-row' }, 'с', from, 'до', to)) : null);
  }

  function render() {
    root.replaceChildren(
      h('p', { class: 'remind-summary' }, opts.summary(snapshot())),
      beforeSection(),
      exactSection(),
      isTask ? repeatSection() : null);
  }

  const snapshot = () => ({ before: [...model.before].sort((a, b) => b - a), at: model.at.slice().sort((a, b) => a - b), every: model.every, window: model.window });

  return {
    set({ before = [], at = [], every = null, window = null } = {}) {
      model.before = new Set(before);
      model.at = at.slice();
      model.every = every;
      model.window = window;
      ui.custom = false;
      ui.exact = false;
      render();
    },
    get: snapshot,
    refresh: render,
    momentsText,
  };
}
