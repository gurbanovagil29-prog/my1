'use strict';

/*
 * Голосовой ввод в строке быстрого добавления: 🎤 — говорите, текст появляется в строке,
 * под ним — как календарь понял фразу; «➤» или Enter — добавить. Распознаёт браузер (Web Speech API).
 * Где браузер этого не умеет (например, iPhone в приложении с экрана «Домой»), подсказываем
 * микрофон на клавиатуре — диктовка даёт тот же текст. Числа словами разбирает parseQuick.
 */

/* global $, toast, renderQuickMode */

const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition || null;
let voiceRec = null;

/** Пустая строка — 🎤, есть текст — «➤ Добавить». */
function syncQuickButtons() {
  const has = Boolean($('#quickInput').value.trim());
  $('#quickVoice').hidden = has && !voiceRec;
  $('#quickSend').hidden = !has || Boolean(voiceRec);
}

function voiceHint() {
  const ios = /iPhone|iPad/.test(navigator.userAgent);
  toast(ios
    ? 'Здесь браузер не распознаёт речь — нажмите 🎤 на клавиатуре iPhone: диктовка впишет фразу в строку'
    : 'Этот браузер не распознаёт речь — откройте календарь в Chrome или используйте микрофон на клавиатуре', { duration: 8000 });
  $('#quickInput').focus();
}

function setVoiceUi(on) {
  $('#quickVoice').classList.toggle('is-listening', on);
  $('#quickVoice').setAttribute('aria-pressed', String(on));
  if (on) $('#quickInput').placeholder = 'Говорите… например: «завтра в 15 встреча с Аней»';
  else renderQuickMode();
  syncQuickButtons();
}

function startVoice() {
  if (voiceRec) { voiceRec.stop(); return; }
  if (!SpeechRec) { voiceHint(); return; }
  const input = $('#quickInput');
  const before = input.value.trim();
  const rec = new SpeechRec();
  rec.lang = 'ru-RU';
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;
  rec.onresult = (e) => {
    const said = [...e.results].map((r) => r[0].transcript).join(' ').replace(/\s+/g, ' ').trim();
    input.value = before ? `${before} ${said}` : said;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  rec.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      if (e.error === 'service-not-allowed') voiceHint();
      else toast('Нет доступа к микрофону — разрешите его в настройках браузера', { duration: 7000 });
    } else if (e.error === 'no-speech') toast('Ничего не расслышал — нажмите 🎤 и скажите ещё раз');
    else if (e.error === 'network') toast('Для распознавания речи нужен интернет');
    else if (e.error !== 'aborted') toast('Не получилось распознать — попробуйте ещё раз');
  };
  rec.onend = () => {
    voiceRec = null;
    // Точку и «!» в конце ставит само распознавание — а «!» в строке значит «закрепить»
    const cleaned = input.value.replace(/[.!…]+\s*$/, '').trim();
    if (cleaned !== input.value) {
      input.value = cleaned;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    setVoiceUi(false);
  };
  try {
    rec.start();
    voiceRec = rec;
    setVoiceUi(true);
  } catch {
    voiceHint();
  }
}

function initVoice() {
  const input = $('#quickInput');
  $('#quickVoice').addEventListener('click', startVoice);
  input.addEventListener('input', syncQuickButtons);
  syncQuickButtons();
}
