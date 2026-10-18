'use strict';

// Собирает серверную функцию Supabase в один файл: его можно вставить в редактор функций в панели Supabase.
// Из core.js берутся только объявления, которые нужны серверу (с их зависимостями), — файл остаётся небольшим.
// Запуск: npm run build:edge

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8').replace(/^'use strict';\n/, '');
const SERVER_SOURCES = ['alarms.js', 'webpush.js', 'reminder-server.js', 'scripts/edge-entry.js'];
const OUT = 'supabase/functions/remind/index.ts';

/** Делит файл на объявления верхнего уровня: { name, code } (комментарий над объявлением идёт вместе с ним). */
function topLevelDeclarations(src) {
  const lines = src.split('\n');
  const decls = [];
  let pending = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(/^(?:async )?function (\w+)|^const (\w+) =/);
    const startsTop = /^(?:\/\*|\/\/|if \(|module\.)/.test(line);
    if (m) {
      cur = { name: m[1] || m[2], code: [...pending, line] };
      pending = [];
      decls.push(cur);
    } else if (startsTop || (cur === null && line.trim())) {
      cur = null;
      pending = /^\/\*\*/.test(line) || (pending.length && !/^\s*$/.test(line)) ? [...pending, line] : [];
      if (/^\/\* -{3,}/.test(line)) pending = [];
    } else if (cur) {
      cur.code.push(line);
    } else if (pending.length) {
      pending.push(line);
    }
  }
  return decls.map((d) => ({ name: d.name, code: d.code.join('\n').replace(/\n+$/, '') }));
}

function pickFromCore(usedBy) {
  const decls = topLevelDeclarations(read('core.js'));
  const byName = new Map(decls.map((d) => [d.name, d]));
  // Комментарии не считаются: упоминание функции в описании — не зависимость
  const stripComments = (code) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  const uses = (code, name) => new RegExp(`(?<![\\w.$])${name}(?![\\w$])`).test(stripComments(code));
  const need = new Set();
  const visit = (code) => {
    for (const d of decls) {
      if (!need.has(d.name) && uses(code, d.name)) {
        need.add(d.name);
        visit(d.code.slice(d.code.indexOf(d.name) + d.name.length));
      }
    }
  };
  visit(usedBy);
  // Сохраняем исходный порядок, чтобы константы шли до функций, которые их используют
  return decls.filter((d) => need.has(d.name)).map((d) => byName.get(d.name).code).join('\n\n');
}

function build() {
  const server = SERVER_SOURCES.map((f) => `// ===== ${f} =====\n${read(f)}`).join('\n');
  return [
    '// @ts-nocheck',
    '// Серверная функция напоминаний календаря. Сгенерировано scripts/build-edge.js — не правьте вручную,',
    '// а измените исходники (core.js, alarms.js, webpush.js, reminder-server.js, scripts/edge-entry.js) и запустите npm run build:edge.',
    '',
    '// ===== core.js (нужная серверу часть) =====',
    pickFromCore(server),
    '',
    server,
  ].join('\n');
}

if (require.main === module) {
  fs.writeFileSync(path.join(root, OUT), build());
  console.log(`Готово: ${OUT}`);
}

module.exports = { build, OUT };
