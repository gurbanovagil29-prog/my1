'use strict';

/*
 * Знакомство при первом входе: 4 экрана с примерами фраз. «Попробовать» вставляет фразу в строку ввода —
 * сразу видно, как календарь её понял. Показывается автоматически только с пустым календарём,
 * потом — из меню «Как пользоваться».
 */

/* global state, sync, h, $, closeNav, openSyncDialog, enableReminders, openNotifySettings */

const ONBOARDED_KEY = 'everyday-calendar:onboarded';

const ONBOARDING = [
  {
    icon: '⚡',
    title: 'Пишите, как говорите',
    text: 'Строка внизу понимает обычные фразы: дату, время, повтор и категорию. До сохранения видно, как она поняла.',
    examples: ['завтра в 15 встреча с Аней', 'по пятницам в 19 спортзал #личное', 'с пятницы до воскресенья дача', '24 октября в 10 защита проекта !'],
    hint: '#личное — категория, «!» — закрепить в обратном отсчёте «До защиты 4 дня».',
  },
  {
    icon: '☑',
    title: 'Задачи и настойчивые напоминания',
    text: 'Задача — то, что нужно отметить сделанным. Календарь будет напоминать, пока не отметите.',
    examples: ['позвонить маме, напоминай каждый час', 'оплатить интернет до пятницы', 'сделать проект в четверг с 19 до 23 @защита'],
    hint: '@защита — привязать к событию: срок задачи — его начало, а «с 19 до 23» — когда вы её делаете.',
  },
  {
    icon: '✨',
    title: 'Календарь думает за вас',
    text: 'Найдёт свободное время с учётом сна, посчитает, куда уходят часы, покажет календари друзей.',
    examples: ['найди 2 часа на этой неделе', 'найди 1.5 часа завтра вечером'],
    list: ['📊 Статистика времени по категориям', '👥 Календари друзей и приглашения на события', '📤 Неделя картинкой — отправить в чат', '🤖 Telegram-бот: фраза боту — и событие в календаре'],
  },
  {
    icon: '📱',
    title: 'Пара шагов — и готово',
    text: 'Чтобы напоминания приходили, даже когда календарь закрыт:',
    setup: true,
  },
];

let onboardingStep = 0;
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
});

const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;

function tryPhrase(text) {
  $('#onboarding').close();
  const input = $('#quickInput');
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
  input.setSelectionRange(text.length, text.length);
}

function setupSteps() {
  const ios = /iPhone|iPad/.test(navigator.userAgent);
  const step = (done, label, action, onclick) => h('div', { class: `onb-step${done ? ' is-done' : ''}` },
    h('span', { class: 'onb-check' }, done ? '✓' : ''),
    h('span', { class: 'onb-step-label' }, label),
    done ? null : h('button', { class: 'btn small', type: 'button', onclick }, action));
  return h('div', { class: 'onb-steps' },
    step(isStandalone(), 'Календарь на экране «Домой»', ios ? 'Как?' : 'Установить', async () => {
      if (installPrompt) {
        installPrompt.prompt();
        await installPrompt.userChoice.catch(() => {});
        installPrompt = null;
        renderOnboarding();
      } else {
        alert(ios
          ? 'В Safari нажмите «Поделиться» (квадрат со стрелкой) → «На экран „Домой“». Потом открывайте календарь с иконки — так работают push-уведомления.'
          : 'В меню браузера выберите «Установить приложение» или «Добавить на главный экран».');
      }
    }),
    step(Boolean(sync.user), 'Вход в аккаунт — данные на всех устройствах', 'Войти', () => { $('#onboarding').close(); openSyncDialog(); }),
    step('Notification' in window && Notification.permission === 'granted', 'Уведомления', 'Включить', async () => { await enableReminders(); renderOnboarding(); }),
    step(false, 'Telegram-бот (по желанию)', 'Подключить', () => { $('#onboarding').close(); openNotifySettings(); }));
}

function renderOnboarding() {
  const s = ONBOARDING[onboardingStep];
  const last = onboardingStep === ONBOARDING.length - 1;
  $('#onbBody').replaceChildren(...[
    h('div', { class: 'onb-icon' }, s.icon),
    h('h2', {}, s.title),
    h('p', { class: 'muted' }, s.text),
    s.examples ? h('div', { class: 'onb-examples' }, s.examples.map((ex) => h('button', { class: 'onb-example', type: 'button', onclick: () => tryPhrase(ex) },
      h('span', {}, `«${ex}»`), h('small', {}, 'Попробовать →')))) : null,
    s.hint ? h('p', { class: 'muted small' }, s.hint) : null,
    s.list ? h('ul', { class: 'onb-list' }, s.list.map((x) => h('li', {}, x))) : null,
    s.setup ? setupSteps() : null].filter(Boolean));
  $('#onbDots').replaceChildren(...ONBOARDING.map((_, i) => h('button', {
    class: `onb-dot${i === onboardingStep ? ' is-active' : ''}`, type: 'button', 'aria-label': `Шаг ${i + 1}`,
    onclick: () => { onboardingStep = i; renderOnboarding(); },
  })));
  $('#onbBack').hidden = onboardingStep === 0;
  $('#onbNext').textContent = last ? 'Готово' : 'Далее';
}

function openOnboarding() {
  closeNav();
  onboardingStep = 0;
  renderOnboarding();
  $('#onboarding').showModal();
}

function initOnboarding() {
  $('#btnOnboarding').addEventListener('click', openOnboarding);
  $('#onbBack').addEventListener('click', () => { onboardingStep = Math.max(0, onboardingStep - 1); renderOnboarding(); });
  $('#onbNext').addEventListener('click', () => {
    if (onboardingStep === ONBOARDING.length - 1) $('#onboarding').close();
    else { onboardingStep += 1; renderOnboarding(); }
  });
  $('#onboarding').addEventListener('close', () => {
    try { localStorage.setItem(ONBOARDED_KEY, '1'); } catch { /* приватный режим */ }
  });
  let seen = false;
  try { seen = Boolean(localStorage.getItem(ONBOARDED_KEY)); } catch { seen = true; }
  // Сами — только новичкам с пустым календарём (и не тем, кто открыл чужую ссылку)
  if (!seen && !state.events.length && !state.tasks.length && !new URLSearchParams(location.search).has('share')) {
    setTimeout(openOnboarding, 500);
  }
}
