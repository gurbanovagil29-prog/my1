'use strict';

/*
 * «Неделя картинкой»: рисует неделю на canvas (а не снимок экрана) — дни, цветные блоки, заголовок —
 * и отдаёт в меню «Поделиться» телефона или скачивает. Перед отправкой: какие категории, с названиями
 * или «только занято», показывать ли задачи.
 */

/* global state, h, $, toast, collect, addDays, startOfWeek, toKey, fromKey, toMin, fromMin, endMinutes, calOf, layoutDay,
   isDailySpan, deadlineOf, WD_SHORT, MONTHS_GEN, sameDay, today */

const IMG = {
  w: 1200, pad: 40, gutter: 64, hour: 44,
  bg: '#ffffff', text: '#1c2024', muted: '#6b7280', line: '#e6e8eb', weekend: '#f8f9fb', accent: '#4f6bed',
  font: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
};

const weekShare = { cals: null, titles: true, tasks: true, blob: null };

function weekDays() {
  const s = startOfWeek(state.cursor);
  return Array.from({ length: 7 }, (_, i) => addDays(s, i));
}

function weekTitle(days) {
  const a = days[0];
  const b = days[6];
  return a.getMonth() === b.getMonth()
    ? `${a.getDate()}–${b.getDate()} ${MONTHS_GEN[b.getMonth()]} ${b.getFullYear()}`
    : `${a.getDate()} ${MONTHS_GEN[a.getMonth()]} – ${b.getDate()} ${MONTHS_GEN[b.getMonth()]} ${b.getFullYear()}`;
}

/** Текст в несколько строк по ширине; лишнее — «…». */
function wrapText(ctx, text, maxW, maxLines) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(next).width <= maxW) cur = next;
    else {
      if (cur) lines.push(cur);
      cur = w;
      while (ctx.measureText(cur).width > maxW && cur.length > 1) {
        // Слово длиннее строки — режем его
        let i = cur.length - 1;
        while (i > 1 && ctx.measureText(`${cur.slice(0, i)}-`).width > maxW) i--;
        lines.push(`${cur.slice(0, i)}-`);
        cur = cur.slice(i);
      }
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const cut = lines.slice(0, maxLines);
    let last = cut[maxLines - 1];
    while (last.length > 1 && ctx.measureText(`${last}…`).width > maxW) last = last.slice(0, -1);
    cut[maxLines - 1] = `${last}…`;
    return cut;
  }
  return lines;
}

function roundRect(ctx, x, y, w, hgt, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + hgt, r);
  ctx.arcTo(x + w, y + hgt, x, y + hgt, r);
  ctx.arcTo(x, y + hgt, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const withAlpha = (hex, a) => `${hex}${Math.round(a * 255).toString(16).padStart(2, '0')}`;

/** Что попадёт на картинку: события и задачи выбранных категорий по дням. */
function weekContent(days) {
  const on = (x) => weekShare.cals.has(calOf(x).id);
  const map = collect(state.events.filter(on), days[0], days[6]);
  const label = (title) => (weekShare.titles ? title : 'Занято');
  return days.map((d) => {
    const key = toKey(d);
    const timed = [];
    const allDay = [];
    for (const o of map.get(key)) {
      const color = calOf(o.ev).color;
      if (o.ev.start && (o.len === 1 || isDailySpan(o.ev))) {
        timed.push({ title: label(o.ev.title), s: toMin(o.ev.start), e: endMinutes(o.ev), color });
      } else allDay.push({ title: label(o.ev.title), color });
    }
    if (weekShare.tasks) {
      for (const t of state.tasks.filter(on)) {
        if (t.done) continue;
        const color = calOf(t).color;
        if (t.plan?.date === key && t.plan.start) {
          const s = toMin(t.plan.start);
          timed.push({ title: `☑ ${label(t.title)}`, s, e: t.plan.end ? toMin(t.plan.end) : Math.min(s + 60, 1440), color, dashed: true });
        }
        const dl = deadlineOf(t);
        if (dl?.date === key && !t.eventId) allDay.push({ title: `⚑ ${dl.time ? `${dl.time} ` : ''}${label(t.title)}`, color, dashed: true });
      }
    }
    return { d, timed: layoutDay(timed), allDay };
  });
}

function drawWeek() {
  const days = weekDays();
  const content = weekContent(days);
  const starts = content.flatMap((c) => c.timed.map((x) => x.s));
  const ends = content.flatMap((c) => c.timed.map((x) => x.e));
  const fromH = Math.min(8, Math.floor(Math.min(1440, ...starts) / 60));
  const toH = Math.max(20, Math.ceil(Math.max(0, ...ends) / 60));
  const allRows = Math.min(4, Math.max(0, ...content.map((c) => c.allDay.length)));
  const { w, pad, gutter, hour } = IMG;
  const colW = (w - pad * 2 - gutter) / 7;
  const headY = pad + 64;
  const dayHeadH = 56;
  const allY = headY + dayHeadH;
  const allH = allRows ? allRows * 30 + 10 : 0;
  const gridY = allY + allH + 8;
  const gridH = (toH - fromH) * hour;
  const height = gridY + gridH + pad + 30;

  const canvas = document.createElement('canvas');
  const scale = 2;
  canvas.width = w * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.fillStyle = IMG.bg;
  ctx.fillRect(0, 0, w, height);
  ctx.textBaseline = 'top';

  // Заголовок
  ctx.fillStyle = IMG.text;
  ctx.font = `700 34px ${IMG.font}`;
  ctx.fillText(`Неделя · ${weekTitle(days)}`, pad, pad);
  const total = content.reduce((n, c) => n + c.timed.length + c.allDay.length, 0);
  ctx.fillStyle = IMG.muted;
  ctx.font = `400 17px ${IMG.font}`;
  ctx.fillText(total ? `Дел на неделе: ${total}` : 'Свободная неделя', pad, pad + 42);

  const x0 = pad + gutter;
  const t = today();
  content.forEach(({ d }, i) => {
    const x = x0 + i * colW;
    if (i >= 5) {
      ctx.fillStyle = IMG.weekend;
      ctx.fillRect(x, headY, colW, gridY + gridH - headY);
    }
    const isToday = sameDay(d, t);
    ctx.fillStyle = isToday ? IMG.accent : IMG.muted;
    ctx.font = `600 14px ${IMG.font}`;
    ctx.fillText(WD_SHORT[i].toUpperCase(), x + 10, headY + 6);
    ctx.fillStyle = isToday ? IMG.accent : IMG.text;
    ctx.font = `700 22px ${IMG.font}`;
    ctx.fillText(String(d.getDate()), x + 10, headY + 24);
  });

  // Весь день
  content.forEach(({ allDay }, i) => {
    const x = x0 + i * colW;
    allDay.slice(0, allRows).forEach((it, k) => {
      const more = k === allRows - 1 && allDay.length > allRows;
      const y = allY + k * 30;
      ctx.fillStyle = withAlpha(it.color, 0.2);
      roundRect(ctx, x + 4, y, colW - 8, 26, 6);
      ctx.fill();
      ctx.fillStyle = IMG.text;
      ctx.font = `600 13px ${IMG.font}`;
      const [line] = wrapText(ctx, more ? `ещё ${allDay.length - allRows + 1}` : it.title, colW - 20, 1);
      ctx.fillText(line, x + 10, y + 6);
    });
  });

  // Сетка по часам
  ctx.strokeStyle = IMG.line;
  ctx.lineWidth = 1;
  for (let hh = fromH; hh <= toH; hh++) {
    const y = gridY + (hh - fromH) * hour;
    ctx.beginPath();
    ctx.moveTo(x0, y + 0.5);
    ctx.lineTo(w - pad, y + 0.5);
    ctx.stroke();
    if (hh < toH) {
      ctx.fillStyle = IMG.muted;
      ctx.font = `400 13px ${IMG.font}`;
      ctx.fillText(`${String(hh).padStart(2, '0')}:00`, pad, y - 7);
    }
  }
  for (let i = 0; i <= 7; i++) {
    ctx.beginPath();
    ctx.moveTo(x0 + i * colW + 0.5, headY);
    ctx.lineTo(x0 + i * colW + 0.5, gridY + gridH);
    ctx.stroke();
  }

  // Блоки
  content.forEach(({ timed }, i) => {
    for (const it of timed) {
      const x = x0 + i * colW + 3 + ((colW - 6) * it.col) / it.cols;
      const bw = (colW - 6) / it.cols - 2;
      const y = gridY + ((Math.max(it.s, fromH * 60) - fromH * 60) / 60) * hour + 1;
      const bh = Math.max(((Math.min(it.e, toH * 60) - Math.max(it.s, fromH * 60)) / 60) * hour - 2, 18);
      ctx.fillStyle = withAlpha(it.color, 0.2);
      roundRect(ctx, x, y, bw, bh, 7);
      ctx.fill();
      if (it.dashed) {
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = it.color;
        roundRect(ctx, x + 0.5, y + 0.5, bw - 1, bh - 1, 7);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.fillStyle = it.color;
      ctx.fillRect(x, y + 2, 3, bh - 4);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, bw, bh);
      ctx.clip();
      ctx.fillStyle = IMG.text;
      ctx.font = `600 14px ${IMG.font}`;
      const lines = wrapText(ctx, it.title, bw - 14, Math.max(1, Math.floor((bh - 22) / 17)));
      lines.forEach((ln, k) => ctx.fillText(ln, x + 9, y + 5 + k * 17));
      if (bh >= 40) {
        ctx.fillStyle = IMG.muted;
        ctx.font = `400 12px ${IMG.font}`;
        ctx.fillText(`${fromMin(it.s)}–${it.e >= 1440 ? '24:00' : fromMin(it.e)}`, x + 9, y + 5 + lines.length * 17);
      }
      ctx.restore();
    }
  });

  ctx.fillStyle = IMG.muted;
  ctx.font = `400 13px ${IMG.font}`;
  ctx.fillText('Сделано в «Календаре»', pad, height - pad);
  return canvas;
}

function renderWeekShare() {
  $('#wsCats').replaceChildren(...state.calendars.map((c) => h('label', { class: 'check', style: { '--c': c.color } },
    h('input', {
      type: 'checkbox', checked: weekShare.cals.has(c.id),
      onchange: (e) => { if (e.target.checked) weekShare.cals.add(c.id); else weekShare.cals.delete(c.id); renderWeekPreview(); },
    }), h('span', { class: 'fe-dot' }), c.name)));
  $('#wsTitles').checked = weekShare.titles;
  $('#wsTasks').checked = weekShare.tasks;
  renderWeekPreview();
}

function renderWeekPreview() {
  const canvas = drawWeek();
  weekShare.blob = null;
  $('#wsPreview').src = canvas.toDataURL('image/png');
  canvas.toBlob((b) => { weekShare.blob = b; }, 'image/png');
}

function openWeekShare() {
  weekShare.cals ||= new Set(state.calendars.filter((c) => c.visible).map((c) => c.id));
  renderWeekShare();
  $('#weekShare').showModal();
}

async function sendWeekImage() {
  const blob = weekShare.blob || await new Promise((res) => drawWeek().toBlob(res, 'image/png'));
  const name = `неделя-${toKey(weekDays()[0])}.png`;
  const file = new File([blob], name, { type: 'image/png' });
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: `Неделя · ${weekTitle(weekDays())}` });
      $('#weekShare').close();
      return;
    }
  } catch (err) {
    if (err?.name === 'AbortError') return;
  }
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast('Картинка недели скачана');
  $('#weekShare').close();
}

function initWeekShare() {
  $('#btnShareWeek').addEventListener('click', openWeekShare);
  $('#wsTitles').addEventListener('change', (e) => { weekShare.titles = e.target.checked; renderWeekPreview(); });
  $('#wsTasks').addEventListener('change', (e) => { weekShare.tasks = e.target.checked; renderWeekPreview(); });
  $('#wsSend').addEventListener('click', sendWeekImage);
}
