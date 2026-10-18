'use strict';

/*
 * Слой поверх календаря, который рисуется после раскладки, по реальным положениям элементов:
 * — подписи многодневных событий: одна надпись по центру всей полосы, через все её клетки;
 * — линии связей: пунктирная стрелка от несделанной задачи к событию, к которому она готовится.
 * Пересчитывается после каждой отрисовки, при изменении размера окна и прокрутке недели.
 */

/* global state, $, $$, findTask, findEvent, colorOf, fitMonthCells */

const SVG_NS = 'http://www.w3.org/2000/svg';
let overlayFrame = 0;

function scheduleOverlays() {
  cancelAnimationFrame(overlayFrame);
  overlayFrame = requestAnimationFrame(layoutOverlays);
}

function layoutOverlays() {
  const view = $('#view');
  if (!view) return;
  fitMonthCells(view);
  layoutSpanLabels(view);
  layoutLinks(view);
}

/** Прямоугольник элемента относительно контейнера (с учётом прокрутки контейнера). */
function relRect(el, box) {
  const r = el.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  return { left: r.left - b.left + box.scrollLeft, top: r.top - b.top + box.scrollTop, width: r.width, height: r.height };
}

/* ---------- Подписи многодневных событий ---------- */

function layoutSpanLabels(view) {
  for (const old of $$('.span-label', view)) old.remove();
  for (const box of $$('.month, .tg-allday', view)) {
    // Части полосы, которые видны (лишнее в клетке месяца спрятано под «ещё N»)
    const segs = new Map();
    const labels = new Map($$('[data-seg-start]', box).map((x) => [x.dataset.seg, x.dataset.label || '']));
    for (const el of $$('[data-seg]', box)) {
      if (el.hidden) continue;
      const seg = segs.get(el.dataset.seg);
      if (seg) seg.last = el;
      else segs.set(el.dataset.seg, { first: el, last: el });
    }
    for (const [id, { first, last }] of segs) {
      const a = relRect(first, box);
      const b = relRect(last, box);
      const label = document.createElement('div');
      label.className = `span-label${first.classList.contains('is-past') ? ' is-past' : ''}`;
      label.style.left = `${a.left}px`;
      label.style.top = `${a.top}px`;
      label.style.width = `${b.left + b.width - a.left}px`;
      label.style.height = `${a.height}px`;
      const text = document.createElement('span');
      text.textContent = labels.get(id) || '';
      label.append(text);
      box.append(label);
    }
  }
}

/* ---------- Линии связей задача → событие ---------- */

/** Элемент события, к которому ведёт задача (у многодневного — его начало, если оно на экране). */
function linkTarget(view, task) {
  const ev = findEvent(task.eventId);
  if (!ev) return null;
  const id = `${ev.id}|${ev.repeat === 'none' ? ev.date : (task.eventKey || ev.date)}`;
  const all = [...view.querySelectorAll('[data-ev]')].filter((x) => x.dataset.ev === id && !x.hidden);
  return all.find((x) => x.classList.contains('span-head')) || all[0] || null;
}

function layoutLinks(view) {
  for (const old of $$('.link-layer', view)) old.remove();
  if (state.settings.links === false) return;
  const layers = new Map(); // контейнер → svg
  const layerFor = (box) => {
    if (!layers.has(box)) {
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('class', 'link-layer');
      svg.setAttribute('aria-hidden', 'true');
      svg.style.width = `${box.scrollWidth}px`;
      svg.style.height = `${box.scrollHeight}px`;
      svg.append(document.createElementNS(SVG_NS, 'defs'));
      box.append(svg);
      layers.set(box, svg);
    }
    return layers.get(box);
  };
  const drawn = new Set();
  for (const from of $$('[data-task]', view)) {
    const task = findTask(from.dataset.task);
    if (from.hidden || !task || task.done || !task.eventId || drawn.has(task.id)) continue;
    const to = linkTarget(view, task);
    if (!to) continue;
    drawn.add(task.id);
    // Оба конца в прокручиваемой сетке недели или ленте месяца — рисуем внутри неё, чтобы линия прокручивалась вместе
    const body = from.closest('.tg-body, .month');
    const box = body && body === to.closest('.tg-body, .month') ? body : view;
    drawLink(layerFor(box), relRect(from, box), relRect(to, box), colorOf(task));
  }
}

function arrowMarker(svg, color) {
  const id = `arrow-${color.replace(/[^a-z0-9]/gi, '')}`;
  if (!svg.querySelector(`#${id}`)) {
    const m = document.createElementNS(SVG_NS, 'marker');
    for (const [k, v] of Object.entries({ id, viewBox: '0 0 10 10', refX: '8', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' })) m.setAttribute(k, v);
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', 'M0,0 L10,5 L0,10 z');
    p.setAttribute('fill', color);
    m.append(p);
    svg.querySelector('defs').append(m);
  }
  return id;
}

/** Плавная пунктирная кривая от края задачи к ближайшему краю события, со стрелкой на конце. */
function drawLink(svg, a, b, color) {
  const ac = { x: a.left + a.width / 2, y: a.top + a.height / 2 };
  const bc = { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  const dx = bc.x - ac.x;
  const dy = bc.y - ac.y;
  let p1;
  let p2;
  let c1;
  let c2;
  if (Math.abs(dx) >= Math.abs(dy) || Math.abs(dx) > Math.max(a.width, b.width) / 2) {
    // Цель правее или левее: выходим из бокового края
    const dir = Math.sign(dx) || 1;
    p1 = { x: dir > 0 ? a.left + a.width : a.left, y: ac.y };
    p2 = { x: dir > 0 ? b.left : b.left + b.width, y: bc.y };
    const bend = Math.max(Math.abs(p2.x - p1.x) * 0.45, 24);
    c1 = { x: p1.x + dir * bend, y: p1.y };
    c2 = { x: p2.x - dir * bend, y: p2.y };
  } else {
    // Цель выше или ниже в той же колонке: выходим сверху/снизу и огибаем дугой
    const dir = Math.sign(dy) || 1;
    p1 = { x: ac.x, y: dir > 0 ? a.top + a.height : a.top };
    p2 = { x: bc.x, y: dir > 0 ? b.top : b.top + b.height };
    const side = Math.min(36, Math.abs(p2.y - p1.y) * 0.5 + 12);
    c1 = { x: p1.x + side, y: p1.y + dir * side };
    c2 = { x: p2.x + side, y: p2.y - dir * side };
  }
  if (Math.hypot(p2.x - p1.x, p2.y - p1.y) < 6) return;
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', `M${p1.x},${p1.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${p2.x},${p2.y}`);
  path.setAttribute('class', 'link-path');
  path.setAttribute('stroke', color);
  path.setAttribute('marker-end', `url(#${arrowMarker(svg, color)})`);
  const dot = document.createElementNS(SVG_NS, 'circle');
  for (const [k, v] of Object.entries({ cx: p1.x, cy: p1.y, r: 2.5, fill: color })) dot.setAttribute(k, v);
  svg.append(path, dot);
}

function initOverlays() {
  window.addEventListener('resize', scheduleOverlays);
  // Прокрутка сетки недели сдвигает элементы относительно линий, нарисованных поверх всего вида
  document.addEventListener('scroll', (e) => {
    if (e.target instanceof Element && e.target.classList.contains('tg-scroll')) scheduleOverlays();
  }, true);
}
