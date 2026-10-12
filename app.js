/* Dark Fusion Dashboard. Источник правды — data.json, сервер пишет его целиком.
   Ничего не захардкожено: название, валюта, цель, площадки и рубрики живут в настройках.
   Интерфейс двуязычный, словарь в i18n.js.
   Без ES-модулей намеренно: ?v= на <script src> не бустит импорты внутри модуля. */
(function () {
  'use strict';

  var S = null;
  var L = 'ru';
  var saveTimer = null;
  var charts = {};
  var $ = function (id) { return document.getElementById(id); };

  // Порядок — это и колонки канбана, и смысл «продвинуть сделку»: вправо ближе к деньгам.
  // Старые файлы знали только lead/work/invoiced/paid; kp и prepaid просто добавились,
  // поэтому миграция ничего не переписывает.
  var STATUSES = ['lead', 'kp', 'invoiced', 'prepaid', 'work', 'paid'];
  var ST_CLS = {
    lead: 't-lead', kp: 't-lead', invoiced: 't-inv',
    prepaid: 't-purple', work: 't-work', paid: 't-paid',
  };
  var RISK_DAYS = 7;
  var TAG_CLS = ['t-report', 't-teardown', 't-dubai', 't-personal'];
  var OLD_RUB = { report: 'Отчёт', teardown: 'Разбор', dubai: 'Дубай', personal: 'Личное' };
  var OLD_PLAT = { threads: 'Threads', telegram: 'Telegram' };

  var t = function (k) {
    var v = window.I18N[L][k];
    return v === undefined ? k : v;
  };

  var n = function (v) { return Math.round(Number(v) || 0).toLocaleString(L === 'ru' ? 'ru-RU' : 'en-US'); };
  var cur = function () { return (S.settings.currency || '').trim(); };
  var money = function (v) { var c = cur(); return n(v) + (c ? ' ' + c : ''); };
  // Дата по локальному календарю, а не по UTC: иначе в Дубае «сегодня» наступает на 4 часа позже.
  var isoD = function (d) { return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
  var today = function () { return isoD(new Date()); };
  var daysBetween = function (a, b) { return Math.round((new Date(b) - new Date(a)) / 864e5); };
  var dmy = function (iso) {
    var p = String(iso || '').split('-');
    if (p.length !== 3) return '';
    var mon = t('months')[Number(p[1]) - 1];
    return L === 'ru' ? Number(p[2]) + ' ' + mon : mon + ' ' + Number(p[2]);
  };
  var uid = function () { return Math.random().toString(36).slice(2, 10); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var list = function (str) {
    return String(str || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  };
  // Сколько по сделке реально получено. Старые записи поля paid не знают:
  // там статус «получено» означал, что пришла вся сумма.
  var got = function (d) {
    if (d.paid != null) return Number(d.paid) || 0;
    return d.status === 'paid' ? Number(d.amount) || 0 : 0;
  };
  // Русский требует трёх форм, английскому хватает двух — обе ветки живут в словаре.
  var plural = function (c) {
    if (L !== 'ru') return c === 1 ? t('deal1') : t('deal2');
    var m10 = c % 10, m100 = c % 100;
    if (m10 === 1 && m100 !== 11) return t('deal1');
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return t('deal2');
    return t('deal5');
  };

  // ─── производные по сделкам ────────────────────────────────────────
  // Последняя активность: позднее из «когда сделка вошла в этап» и записей по клиенту.
  // Нужна и карточке канбана, и панели внимания, поэтому считается в одном месте.
  function lastAct(d) {
    var best = d.stage_date || d.date || '';
    S.notes.forEach(function (nt) {
      if (nt.client === d.client && nt.date && nt.date > best) best = nt.date;
    });
    return best;
  }
  function idleDays(d) {
    var a = lastAct(d);
    return a ? Math.max(0, daysBetween(a, today())) : null;
  }
  function atRisk(d) {
    var k = idleDays(d);
    return d.status !== 'paid' && k !== null && k > RISK_DAYS;
  }

  function metrics() {
    var m = { paid: 0, open: 0, active: 0, closed: 0, won: 0, conv: 0, win: 0, cycle: null };
    var cycles = [];
    S.deals.forEach(function (d) {
      var a = Number(d.amount) || 0, p = got(d);
      m.paid += p;
      m.open += Math.max(0, a - p);
      if (d.status !== 'paid') m.active++;
      if (p > 0) m.closed++;
      if (d.status === 'paid') {
        m.won++;
        // Цикл считаем только там, где известны и первое касание, и дата попадания в «оплачено».
        if (d.date && d.stage_date && d.stage_date >= d.date) cycles.push(daysBetween(d.date, d.stage_date));
      }
    });
    if (S.deals.length) {
      m.conv = (m.closed / S.deals.length) * 100;
      m.win = (m.won / S.deals.length) * 100;
    }
    if (cycles.length) m.cycle = Math.round(cycles.reduce(function (a, b) { return a + b; }, 0) / cycles.length);
    return m;
  }

  // Клиенты не отдельная сущность: список собирается из сделок и записей активности.
  function clients() {
    var map = {};
    function slot(name) {
      if (!map[name]) map[name] = { name: name, got: 0, open: 0, deals: 0, notes: 0, last: '' };
      return map[name];
    }
    S.deals.forEach(function (d) {
      var c = slot(d.client || '—');
      var a = Number(d.amount) || 0, p = got(d);
      c.got += p; c.open += Math.max(0, a - p); c.deals++;
      var la = lastAct(d);
      if (la > c.last) c.last = la;
    });
    S.notes.forEach(function (nt) {
      var c = slot(nt.client || '—');
      c.notes++;
      if (nt.date > c.last) c.last = nt.date;
    });
    return Object.keys(map).map(function (k) { return map[k]; })
      .sort(function (a, b) { return b.got - a.got || (b.last < a.last ? -1 : 1); });
  }

  function greeting() {
    var h = new Date().getHours();
    var k = h < 5 ? 'night' : h < 12 ? 'morning' : h < 18 ? 'day' : 'evening';
    var name = (S.settings.name || '').trim();
    return t('greet.' + k) + (name ? ', ' + name : '');
  }

  function flag(text, kind) {
    var el = $('saved');
    el.textContent = text;
    el.className = 'saved' + (kind ? ' ' + kind : '');
  }

  // Два режима. С сервером (node server.js) источник правды — data.json на диске.
  // Без сервера (GitHub Pages, открытый файл) данные живут в браузере и никуда не уходят:
  // выкладывать на Pages можно только код, цифры остаются на устройстве.
  var LOCAL_KEY = 'kanalData';
  var standalone = false;

  function blank() {
    return { meta: { version: 4 }, settings: {}, profile: {}, deals: [], subs: [], posts: [], log: [], notes: [] };
  }

  function load() {
    fetch('api/data', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) { S = migrate(d); boot(); })
      .catch(function () {
        standalone = true;
        var raw = null;
        try { raw = localStorage.getItem(LOCAL_KEY); } catch (e) { /* приватный режим — читать нечем */ }
        var parsed = blank();
        if (raw) {
          try { parsed = JSON.parse(raw); } catch (e) { flag(t('localBroken'), 'err'); }
        }
        S = migrate(parsed);
        boot();
      });
  }

  // Файл мог быть любой из прошлых версий — достраиваем недостающее, ничего не теряя.
  function migrate(d) {
    d.settings = d.settings || {};
    d.profile = d.profile || {};
    d.deals = d.deals || [];
    d.subs = d.subs || [];
    d.posts = d.posts || [];
    d.log = d.log || [];
    d.notes = d.notes || [];

    if (d.goal) {
      if (d.settings.goal === undefined && d.goal.target) d.settings.goal = d.goal.target;
      if (!d.settings.currency && d.goal.currency) d.settings.currency = d.goal.currency;
      if (!d.settings.deadline && d.goal.deadline) d.settings.deadline = d.goal.deadline;
      delete d.goal;
    }
    if (d.income && d.income.length && !d.deals.length) {
      d.deals = d.income.map(function (i) {
        return { id: uid(), client: i.source, amount: i.amount, status: i.status === 'paid' ? 'paid' : 'invoiced', date: i.date, service: '', url: '' };
      });
    }
    delete d.income; delete d.channels; delete d.plan; delete d.rubrics;

    d.posts.forEach(function (p) {
      if (OLD_RUB[p.rubric]) p.rubric = OLD_RUB[p.rubric];
      if (OLD_PLAT[p.platform]) p.platform = OLD_PLAT[p.platform];
    });
    d.subs.forEach(function (s) { if (OLD_PLAT[s.platform]) s.platform = OLD_PLAT[s.platform]; });

    [d.deals, d.subs, d.posts, d.log, d.notes].forEach(function (arr) {
      arr.forEach(function (it) { if (!it.id) it.id = uid(); });
    });
    // До появления частичной оплаты «получено» значило всю сумму сразу.
    d.deals.forEach(function (x) {
      if (x.paid == null) x.paid = x.status === 'paid' ? Number(x.amount) || 0 : 0;
      // Когда сделка попала в текущий этап. У старых записей этого нет — берём дату сделки,
      // иначе «дней в этапе» и средний цикл посчитались бы от нуля.
      if (!x.stage_date) x.stage_date = x.date || today();
    });
    // Имя для приветствия: берём первое слово из «кто я», но дальше оно живёт
    // отдельным полем настроек и правится руками.
    if (d.settings.name === undefined) {
      var who = String(d.profile.who || '').trim();
      d.settings.name = who ? who.split(/[\s,.]+/)[0] : '';
    }
    return d;
  }

  function push() {
    if (standalone) {
      S.meta = S.meta || {};
      S.meta.updated = today();
      return new Promise(function (res, rej) {
        try {
          localStorage.setItem(LOCAL_KEY, JSON.stringify(S));
          res({ ok: true, updated: S.meta.updated });
        } catch (e) {
          rej(new Error(t('localFull')));
        }
      });
    }
    return fetch('api/data', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(S),
    }).then(function (r) {
      return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || r.status); return j; });
    });
  }

  function save(skipRender) {
    if (!skipRender) render();
    flag(t('saving'));
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      push().then(function () { flag(t('saved'), 'ok'); })
        .catch(function (e) { flag(t('saveErr') + e.message, 'err'); });
    }, 500);
  }

  // Предыдущее значение держим в dataset, а не парсим из текста: у процентов и дробей
  // в подписи есть запятая и знак, и разбор текста давал бы неверную точку старта.
  function countUp(el, to, fmt) {
    fmt = fmt || n;
    var from = Number(el.dataset.v);
    if (!isFinite(from)) from = 0;
    el.dataset.v = to;
    // В скрытой вкладке requestAnimationFrame не вызывается — анимация замерла бы
    // на начальном значении и показывала неверную сумму. Там ставим итог сразу.
    if (from === to || document.hidden) { el.textContent = fmt(to); return; }
    var t0 = performance.now(), dur = 800;
    (function tick(ts) {
      var k = Math.min(1, (ts - t0) / dur);
      el.textContent = fmt(from + (to - from) * (1 - Math.pow(1 - k, 3)));
      if (k < 1) requestAnimationFrame(tick);
    })(t0);
  }
  // Мелкие доли округлять до целого нельзя: 2 % цели превратились бы в 2 %, а 0,4 % — в 0 %.
  var pctFmt = function (v) {
    var s = v > 0 && v < 10 ? v.toFixed(1) : String(Math.round(v));
    return (L === 'ru' ? s.replace('.', ',') : s) + ' %';
  };

  // ─── графики ───────────────────────────────────────────────────────
  function theme() { return document.documentElement.dataset.theme; }
  function palette() {
    var dark = theme() === 'dark';
    return {
      acc: '#FF752A',
      green: dark ? '#4DAB9A' : '#0F7B5F',
      amber: dark ? '#D9A441' : '#C08A2E',
      purple: dark ? '#9A6DD7' : '#6940A5',
      blue: dark ? '#6B9BD8' : '#2B6CB0',
      grid: dark ? 'rgba(255,255,255,.07)' : 'rgba(15,15,15,.07)',
      tick: dark ? '#78776F' : '#A5A199',
      tipBg: dark ? '#2C2C2C' : '#37352F',
    };
  }
  function fade(ctx, area, hex, a1, a2) {
    if (!area) return hex + a1;
    var g = ctx.createLinearGradient(0, area.top, 0, area.bottom);
    g.addColorStop(0, hex + a1);
    g.addColorStop(1, hex + a2);
    return g;
  }
  function base(P) {
    return {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 800, easing: 'easeOutCubic' },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: P.tipBg, padding: 10, cornerRadius: 7, displayColors: false,
          titleFont: { family: "'Inter', sans-serif", size: 12, weight: '500' },
          bodyFont: { family: "'JetBrains Mono', monospace", size: 13 },
        },
      },
    };
  }
  function tickCfg(P) { return { color: P.tick, font: { size: 11, family: "'JetBrains Mono', monospace" } }; }

  function drawChart(wrapId, key, emptyText, cfg) {
    var wrap = $(wrapId);
    if (charts[key]) { charts[key].destroy(); delete charts[key]; }
    if (!cfg) { wrap.innerHTML = '<div class="chart-empty">' + esc(emptyText) + '</div>'; return; }
    wrap.innerHTML = '<div class="chart-box"><canvas id="cv-' + key + '" role="img" aria-label="'
      + esc(cfg.aria) + '">' + esc(cfg.aria) + '</canvas></div>';
    charts[key] = new Chart($('cv-' + key), cfg.chart);
  }

  function renderMoneyChart() {
    var P = palette();
    var paid = S.deals.filter(function (d) { return got(d) > 0 && d.date; });
    if (!paid.length) { drawChart('chMoney', 'money', t('ch.moneyEmpty')); return; }
    var months = {};
    paid.forEach(function (d) {
      var k = String(d.date).slice(0, 7);
      months[k] = (months[k] || 0) + got(d);
    });
    var keys = Object.keys(months).sort();
    var o = base(P);
    o.plugins.tooltip.callbacks = { label: function (c) { return money(c.parsed.y); } };
    o.scales = {
      x: { grid: { display: false }, border: { display: false }, ticks: tickCfg(P) },
      y: {
        beginAtZero: true, grid: { color: P.grid, drawTicks: false }, border: { display: false },
        ticks: Object.assign({}, tickCfg(P), { callback: function (v) { return n(v); } }),
      },
    };
    drawChart('chMoney', 'money', '', {
      aria: t('ch.money'),
      chart: {
        type: 'bar',
        data: {
          labels: keys.map(function (k) { return t('months')[Number(k.slice(5, 7)) - 1]; }),
          datasets: [{
            data: keys.map(function (k) { return months[k]; }),
            backgroundColor: function (c) { return fade(c.chart.ctx, c.chart.chartArea, P.green, 'FF', '66'); },
            borderRadius: 6, maxBarThickness: 52,
          }],
        },
        options: o,
      },
    });
  }

  function renderSubsChart() {
    var P = palette();
    if (S.subs.length < 2) { drawChart('chSubs', 'subs', t('ch.subsEmpty')); return; }
    var dates = [];
    S.subs.forEach(function (s) { if (dates.indexOf(s.date) < 0) dates.push(s.date); });
    dates.sort();
    var plats = [];
    S.subs.forEach(function (s) { if (plats.indexOf(s.platform) < 0) plats.push(s.platform); });
    var colors = [P.acc, P.green, P.purple, P.amber];
    var sets = plats.map(function (p, i) {
      var col = colors[i % 4];
      return {
        label: p,
        data: dates.map(function (d) {
          var hit = S.subs.filter(function (s) { return s.platform === p && s.date === d; })[0];
          return hit ? Number(hit.count) || 0 : null;
        }),
        spanGaps: true, borderColor: col,
        backgroundColor: function (c) { return fade(c.chart.ctx, c.chart.chartArea, col, '2E', '00'); },
        fill: true, borderDash: i % 2 ? [6, 4] : [],
        pointStyle: i % 2 ? 'rect' : 'circle',
        pointBackgroundColor: col, pointRadius: 3.5, pointHoverRadius: 5.5,
        borderWidth: 2.2, tension: .32,
      };
    });
    var o = base(P);
    o.interaction = { mode: 'index', intersect: false };
    o.plugins.legend = {
      display: true, position: 'top', align: 'end',
      labels: { usePointStyle: true, boxWidth: 7, boxHeight: 7, padding: 16, color: P.tick, font: { size: 11, family: "'Inter', sans-serif" } },
    };
    o.scales = {
      x: { grid: { display: false }, border: { display: false }, ticks: tickCfg(P) },
      y: { beginAtZero: true, grid: { color: P.grid, drawTicks: false }, border: { display: false }, ticks: tickCfg(P) },
    };
    drawChart('chSubs', 'subs', '', {
      aria: t('ch.subs'),
      chart: { type: 'line', data: { labels: dates.map(dmy), datasets: sets }, options: o },
    });
  }

  function renderRubricChart() {
    var P = palette();
    var withViews = S.posts.filter(function (p) { return Number(p.views) > 0; });
    if (!withViews.length) { drawChart('chRubric', 'rubric', t('ch.rubricEmpty')); return; }
    var rubs = list(S.settings.rubrics);
    if (!rubs.length) withViews.forEach(function (p) { if (p.rubric && rubs.indexOf(p.rubric) < 0) rubs.push(p.rubric); });
    if (!rubs.length) { drawChart('chRubric', 'rubric', t('ch.noRubrics')); return; }
    var colors = [P.acc, P.green, P.purple, P.amber];
    var o = base(P);
    o.indexAxis = 'y';
    o.plugins.tooltip.callbacks = { label: function (c) { return n(c.parsed.x) + ' ' + t('views'); } };
    o.scales = {
      x: {
        beginAtZero: true, grid: { color: P.grid, drawTicks: false }, border: { display: false },
        ticks: Object.assign({}, tickCfg(P), { callback: function (v) { return n(v); } }),
      },
      y: { grid: { display: false }, border: { display: false }, ticks: tickCfg(P) },
    };
    drawChart('chRubric', 'rubric', '', {
      aria: t('ch.rubric'),
      chart: {
        type: 'bar',
        data: {
          labels: rubs,
          datasets: [{
            data: rubs.map(function (r) {
              return withViews.filter(function (p) { return p.rubric === r; })
                .reduce(function (a, p) { return a + (Number(p.views) || 0); }, 0);
            }),
            backgroundColor: rubs.map(function (_, i) { return colors[i % 4]; }),
            borderRadius: 6, maxBarThickness: 24,
          }],
        },
        options: o,
      },
    });
  }

  // Понедельник недели, в которую попала дата. ОАЭ без перехода на зимнее время,
  // поэтому арифметика сутками здесь безопасна.
  function monday(iso) {
    var dt = new Date(iso);
    dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
    return isoD(dt);
  }

  function renderWeekChart() {
    var P = palette();
    var withMoney = S.deals.filter(function (d) { return got(d) > 0 && d.date; });
    if (!withMoney.length) { drawChart('chWeek', 'week', t('ch.weekEmpty')); return; }
    var keys = [], base0 = new Date(monday(today()));
    for (var i = 7; i >= 0; i--) keys.push(isoD(new Date(base0.getTime() - i * 7 * 864e5)));
    var sums = {};
    keys.forEach(function (k) { sums[k] = 0; });
    withMoney.forEach(function (d) {
      var k = monday(d.date);
      if (sums[k] !== undefined) sums[k] += got(d);
    });
    var o = base(P);
    o.plugins.tooltip.callbacks = { label: function (c) { return money(c.parsed.y); } };
    o.scales = {
      x: { grid: { display: false }, border: { display: false }, ticks: tickCfg(P) },
      y: {
        beginAtZero: true, grid: { color: P.grid, drawTicks: false }, border: { display: false },
        ticks: Object.assign({}, tickCfg(P), { callback: function (v) { return n(v); } }),
      },
    };
    drawChart('chWeek', 'week', '', {
      aria: t('ch.week'),
      chart: {
        type: 'line',
        data: {
          labels: keys.map(dmy),
          datasets: [{
            data: keys.map(function (k) { return sums[k]; }),
            borderColor: P.acc, borderWidth: 2.2, tension: .35, fill: true,
            backgroundColor: function (c) { return fade(c.chart.ctx, c.chart.chartArea, P.acc, '3A', '00'); },
            pointBackgroundColor: P.acc, pointRadius: 3, pointHoverRadius: 5.5,
          }],
        },
        options: o,
      },
    });
  }

  function stageColors(P) {
    return { lead: P.tick, kp: P.purple, invoiced: P.acc, prepaid: P.amber, work: P.blue, paid: P.green };
  }

  function renderHealthChart() {
    var P = palette();
    if (!S.deals.length) { drawChart('chHealth', 'health', t('ch.healthEmpty')); return; }
    var SC = stageColors(P);
    // Пустые этапы в пончик не попадают — иначе легенда забита нулями.
    var used = STATUSES.filter(function (st) {
      return S.deals.filter(function (d) { return d.status === st; }).length > 0;
    });
    var o = base(P);
    o.cutout = '62%';
    o.plugins.tooltip.callbacks = {
      label: function (c) { return c.parsed + ' ' + plural(c.parsed); },
    };
    o.plugins.legend = {
      display: true, position: 'right',
      labels: { usePointStyle: true, boxWidth: 7, boxHeight: 7, padding: 11, color: P.tick, font: { size: 11, family: "'Inter', sans-serif" } },
    };
    drawChart('chHealth', 'health', '', {
      aria: t('ch.health'),
      chart: {
        type: 'doughnut',
        data: {
          labels: used.map(function (st) { return t('st.' + st); }),
          datasets: [{
            data: used.map(function (st) { return S.deals.filter(function (d) { return d.status === st; }).length; }),
            backgroundColor: used.map(function (st) { return SC[st]; }),
            borderWidth: 0, hoverOffset: 6,
          }],
        },
        options: o,
      },
    });
  }

  // ─── блоки ─────────────────────────────────────────────────────────
  function renderOverview() {
    var title = (S.settings.title || '').trim();
    $('ovTitle').textContent = title || t('nav.overview');
    $('ovSub').textContent = (S.settings.subtitle || '').trim();
    $('ovSub').style.display = S.settings.subtitle ? '' : 'none';
    $('brandT').textContent = title || 'Dark Fusion';
    $('crumb').textContent = title || t('dashboard');
    document.title = title ? title + ' · Dark Fusion' : 'Dark Fusion Dashboard';

    $('greet').textContent = greeting() + ' · ' + dmy(today());

    // Сделка живёт одной строкой: amount — вся стоимость, paid — сколько пришло.
    // Предоплата 50 % не плодит второй сделки, поэтому в списке нет дублей.
    var m = metrics();
    var goal = Number(S.settings.goal) || 0;

    countUp($('mPaid'), m.paid);
    $('mPaidS').textContent = m.closed ? m.closed + ' ' + plural(m.closed) : t('m.nothing');
    $('mPaidBar').style.width = goal ? Math.min(100, (m.paid / goal) * 100) + '%' : '0%';
    countUp($('mPipe'), m.open);
    countUp($('mActive'), m.active);
    countUp($('mConv'), m.conv, pctFmt);

    renderAssist();

    // Блок цели рисуется только если цель задана — иначе его просто нет.
    var paid = m.paid;
    if (!goal) { $('goalBox').innerHTML = ''; }
    else {
      var pct = (paid / goal) * 100;
      var dl = '';
      if (S.settings.deadline) {
        var days = Math.round((new Date(S.settings.deadline) - new Date(today())) / 864e5);
        dl = days >= 0 ? t('m.due') + ' ' + dmy(S.settings.deadline) : t('m.overdue');
      }
      $('goalBox').innerHTML = '<div class="hero" style="margin-bottom:13px"><div class="hero-top">'
        + '<div><div class="big">' + money(paid) + '</div><div class="big-s">' + t('m.of') + ' ' + money(goal) + '</div></div>'
        + '<span class="pct">' + (pct > 0 && pct < 10 ? pct.toFixed(1) : Math.round(pct)) + '%</span></div>'
        + '<div class="track"><i style="width:' + Math.min(100, pct) + '%"></i></div>'
        + '<div class="hero-n">' + esc(dl) + '</div></div>';
    }

    $('cDeals').textContent = S.deals.length || '';
    $('cPipe').textContent = m.active || '';
    $('cClients').textContent = clients().length || '';
    $('cPosts').textContent = S.posts.length || '';
    $('cLog').textContent = S.log.length || '';
  }

  // Сколько сделок без движения и на какую сумму. Берём остаток к оплате,
  // а не всю стоимость: под угрозой именно не пришедшие деньги.
  function renderAssist() {
    var box = $('assist');
    var risky = S.deals.filter(atRisk).sort(function (a, b) { return idleDays(b) - idleDays(a); });
    if (!risky.length) { box.innerHTML = '<div class="empty">' + esc(t('as.none')) + '</div>'; return; }
    var sum = risky.reduce(function (a, d) { return a + Math.max(0, (Number(d.amount) || 0) - got(d)); }, 0);
    box.innerHTML = '<div class="as-head">' + esc(t('as.sub')) + ' · <b>' + esc(money(sum)) + '</b> ' + esc(t('as.risk')) + '</div>'
      + risky.map(function (d) {
        var a = Number(d.amount) || 0, p = got(d);
        return '<div class="as-row"><div><div class="as-c">' + esc(d.client) + '</div>'
          + '<div class="as-m">' + esc(t('st.' + d.status)) + (d.service ? ' · ' + esc(d.service) : '') + '</div></div>'
          + '<div class="as-a"><div class="as-sum">' + esc(money(Math.max(0, a - p))) + '</div>'
          + '<div class="as-d">' + idleDays(d) + ' ' + esc(t('as.days')) + '</div></div></div>';
      }).join('');
  }

  function renderContentMetrics() {
    $('mPosts').textContent = S.posts.length;
    var byPlat = {};
    S.subs.slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; }).forEach(function (s) {
      byPlat[s.platform] = Number(s.count) || 0;
    });
    var totalSubs = Object.keys(byPlat).reduce(function (a, k) { return a + byPlat[k]; }, 0);
    $('mSubs').textContent = S.subs.length ? n(totalSubs) : '—';
    $('mSubsS').textContent = S.subs.length ? Object.keys(byPlat).join(' + ') : t('m.noSnaps');
  }

  function renderDeals() {
    var box = $('dealRows');
    if (!S.deals.length) {
      box.innerHTML = '<tr><td colspan="5" class="empty">' + t('e.deals') + '</td></tr>';
      return;
    }
    var rows = S.deals.slice().sort(function (a, b) { return (b.date || '') < (a.date || '') ? -1 : 1; });
    box.innerHTML = rows.map(function (d) {
      var a = Number(d.amount) || 0, p = got(d);
      // Частичную оплату показываем дробью: видно и что пришло, и сколько висит.
      var sum = a ? (p > 0 && p < a ? n(p) + ' / ' + n(a) : n(a)) : (p ? n(p) : '—');
      return '<tr><td>' + (d.url ? '<a href="' + esc(d.url) + '" target="_blank" rel="noopener">' + esc(d.client) + '</a>' : esc(d.client)) + '</td>'
        + '<td>' + esc(d.service || '') + '</td>'
        + '<td><span class="tag ' + ST_CLS[d.status] + '">' + t('st.' + d.status) + '</span></td>'
        + '<td class="tnum" style="font-size:12px">' + esc(dmy(d.date)) + '</td>'
        + '<td class="cell-a">' + sum
        + ' <button class="del" data-del="deals" data-id="' + esc(d.id) + '" aria-label="' + t('del') + '">&times;</button></td></tr>';
    }).join('');
  }

  // ─── воронка ───────────────────────────────────────────────────────
  // Карточка, только что приехавшая в новую колонку, получает класс посадки один раз.
  var justMoved = null;

  function renderBoard() {
    $('board').innerHTML = STATUSES.map(function (st) {
      var ds = S.deals.filter(function (d) { return d.status === st; })
        .sort(function (a, b) { return (Number(b.amount) || 0) - (Number(a.amount) || 0); });
      // Итог колонки — стоимость сделок на этапе, а не полученное:
      // так видно, сколько денег стоит на каждой ступени.
      var sum = ds.reduce(function (a, d) { return a + (Number(d.amount) || 0); }, 0);
      var cards = ds.length ? ds.map(function (d) {
        var a = Number(d.amount) || 0, p = got(d);
        var val = a ? (p > 0 && p < a ? n(p) + ' <span class="part">/ ' + n(a) + '</span>' : n(a)) : (p ? n(p) : '—');
        var inStage = d.stage_date ? Math.max(0, daysBetween(d.stage_date, today())) : null;
        var idle = idleDays(d);
        return '<div class="dcard' + (atRisk(d) ? ' risk' : '') + (justMoved === d.id ? ' just-moved' : '')
          + '" data-id="' + esc(d.id) + '">'
          + '<div class="dcard-c">' + esc(d.client) + '</div>'
          + '<div class="dcard-a">' + val + '</div>'
          + '<div class="dcard-m">'
          + (inStage === null ? '' : '<span>' + inStage + ' ' + esc(t('pipe.inStage')) + '</span><span>·</span>')
          + '<span>' + (idle === null ? esc(t('pipe.noAct')) : idle + ' ' + esc(t('days'))) + '</span>'
          + '</div></div>';
      }).join('') : '<div class="col-e">' + esc(t('pipe.empty')) + '</div>';
      return '<div class="col" data-st="' + st + '">'
        + '<div class="col-h"><span class="col-n">' + esc(t('st.' + st)) + '</span>'
        + '<span class="col-c">' + ds.length + '</span></div>'
        + '<div class="col-s">' + esc(money(sum)) + '</div>'
        + '<div class="col-b">' + cards + '</div></div>';
    }).join('');
    justMoved = null;
  }

  // Перенос на pointer events, а не на HTML5 drag-and-drop: тот не работает на тач
  // и не даёт управлять видом «поднятой» карточки.
  function initDnD() {
    var board = $('board');
    var drag = null;

    function clearOver() {
      Array.prototype.forEach.call(board.querySelectorAll('.col.over'), function (c) { c.classList.remove('over'); });
    }

    // Шесть колонок не влезают в экран ноутбука, а pointermove не приходит, пока
    // курсор стоит на месте — поэтому у края доска едет сама, по таймеру.
    // setInterval, а не requestAnimationFrame: rAF не работает в скрытой вкладке.
    var scroller = null;
    function edgeScroll(dir) {
      if (scroller && scroller.dir === dir) return;
      stopScroll();
      if (!dir) return;
      scroller = { dir: dir, id: setInterval(function () { board.scrollLeft += dir * 14; }, 16) };
    }
    function stopScroll() {
      if (scroller) { clearInterval(scroller.id); scroller = null; }
    }

    board.addEventListener('pointerdown', function (e) {
      if (e.button) return;
      var card = e.target.closest('.dcard');
      if (!card) return;
      var r = card.getBoundingClientRect();
      drag = {
        id: card.dataset.id, card: card, ghost: null, moved: false, target: null,
        dx: e.clientX - r.left, dy: e.clientY - r.top, w: r.width,
        x0: e.clientX, y0: e.clientY,
      };
      card.setPointerCapture(e.pointerId);
    });

    board.addEventListener('pointermove', function (e) {
      if (!drag) return;
      if (!drag.moved) {
        // Порог в 4 px, иначе обычный клик по карточке уже считался бы переносом.
        if (Math.abs(e.clientX - drag.x0) + Math.abs(e.clientY - drag.y0) < 4) return;
        drag.moved = true;
        drag.ghost = drag.card.cloneNode(true);
        drag.ghost.className = 'dcard drag-ghost';
        drag.ghost.style.width = drag.w + 'px';
        document.body.appendChild(drag.ghost);
        drag.card.classList.add('ghosted');
      }
      // Позицию двигаем прямо в обработчике, без requestAnimationFrame: в скрытой
      // вкладке rAF не вызывается, и перенос бы не работал вообще.
      drag.ghost.style.left = (e.clientX - drag.dx) + 'px';
      drag.ghost.style.top = (e.clientY - drag.dy) + 'px';
      var br = board.getBoundingClientRect();
      var EDGE = 64;
      edgeScroll(e.clientX > br.right - EDGE ? 1 : e.clientX < br.left + EDGE ? -1 : 0);

      // У призрака pointer-events:none, поэтому под курсором видна колонка, а не он сам.
      var under = document.elementFromPoint(e.clientX, e.clientY);
      var col = under && under.closest ? under.closest('.col') : null;
      if (col !== drag.target) {
        clearOver();
        drag.target = col;
        if (col) col.classList.add('over');
      }
    });

    function finish() {
      if (!drag) return;
      var d = drag;
      drag = null;
      stopScroll();
      clearOver();
      if (!d.moved) return;
      var to = d.target && d.target.dataset.st;
      var deal = S.deals.filter(function (x) { return x.id === d.id; })[0];
      var ghost = d.ghost;

      if (!deal || !to || deal.status === to) {
        // Бросили мимо или в ту же колонку — призрак пружиной возвращается на место.
        var r = d.card.getBoundingClientRect();
        ghost.classList.add('settle');
        ghost.style.left = r.left + 'px';
        ghost.style.top = r.top + 'px';
        ghost.style.transform = 'scale(1) rotate(0deg)';
        setTimeout(function () { ghost.remove(); d.card.classList.remove('ghosted'); }, 340);
        return;
      }

      deal.status = to;
      deal.stage_date = today();
      // «Оплачено» означает всю сумму: иначе касса разошлась бы с воронкой.
      if (to === 'paid') deal.paid = Number(deal.amount) || 0;
      // Предоплату заполняем только если не записано ничего — реальную частичную
      // сумму перетаскивание затирать не должно.
      if (to === 'prepaid' && got(deal) === 0) deal.paid = Math.round((Number(deal.amount) || 0) / 2);

      ghost.classList.add('settle');
      ghost.style.opacity = '0';
      ghost.style.transform = 'scale(.96) rotate(0deg)';
      setTimeout(function () { ghost.remove(); }, 340);
      justMoved = deal.id;
      save();
    }

    board.addEventListener('pointerup', finish);
    board.addEventListener('pointercancel', finish);
  }

  // ─── отчёты ────────────────────────────────────────────────────────
  function renderReports() {
    var m = metrics();
    countUp($('rRev'), m.paid);
    $('rRevS').textContent = cur();
    countUp($('rClosed'), m.closed);
    $('rClosedS').textContent = m.closed ? plural(m.closed) : t('m.nothing');
    countUp($('rWin'), m.win, pctFmt);
    if (m.cycle === null) {
      $('rCycle').textContent = '—';
      $('rCycle').dataset.v = '';
      $('rCycleS').textContent = t('rep.noData');
    } else {
      countUp($('rCycle'), m.cycle);
      $('rCycleS').textContent = t('rep.cycleDays');
    }

    var box = $('boardRows');
    var cs = clients().filter(function (c) { return c.deals > 0; });
    if (!cs.length) { box.innerHTML = '<tr><td colspan="3" class="empty">' + esc(t('e.deals')) + '</td></tr>'; return; }
    box.innerHTML = cs.map(function (c) {
      return '<tr><td>' + esc(c.name) + '</td>'
        + '<td class="tnum">' + c.deals + '</td>'
        + '<td class="cell-a">' + esc(money(c.got)) + '</td></tr>';
    }).join('');
  }

  // ─── клиенты ───────────────────────────────────────────────────────
  var selClient = null;

  function renderClients() {
    var q = ($('clSearch').value || '').trim().toLowerCase();
    var all = clients();
    var shown = q ? all.filter(function (c) { return c.name.toLowerCase().indexOf(q) >= 0; }) : all;
    var box = $('clList');
    if (!shown.length) {
      box.innerHTML = '<div class="empty">' + esc(all.length ? t('cl.none') : t('e.deals')) + '</div>';
      $('clBody').innerHTML = '';
      return;
    }
    // Выбранный мог отфильтроваться поиском — тогда показываем первого из найденных.
    var stillThere = shown.filter(function (c) { return c.name === selClient; }).length > 0;
    if (!stillThere) selClient = shown[0].name;
    box.innerHTML = shown.map(function (c) {
      return '<button class="cl-i' + (c.name === selClient ? ' on' : '') + '" data-cl="' + esc(c.name) + '">'
        + '<span class="cl-i-n">' + esc(c.name) + '</span>'
        + '<span class="cl-i-s">' + n(c.got) + '</span></button>';
    }).join('');
    renderClientBody();
  }

  function renderClientBody() {
    var box = $('clBody');
    var c = clients().filter(function (x) { return x.name === selClient; })[0];
    if (!c) { box.innerHTML = '<div class="empty">' + esc(t('cl.pick')) + '</div>'; return; }

    var deals = S.deals.filter(function (d) { return d.client === c.name; })
      .sort(function (a, b) { return (b.date || '') < (a.date || '') ? -1 : 1; });
    var notes = S.notes.filter(function (nt) { return nt.client === c.name; })
      .sort(function (a, b) { return b.date < a.date ? -1 : 1; });

    box.innerHTML = '<h2 style="margin:0 0 4px">' + esc(c.name) + '</h2>'
      + '<div class="cl-sums">'
      + '<div><div class="cl-sum-k">' + esc(t('cl.got')) + '</div><div class="cl-sum-v">' + esc(money(c.got)) + '</div></div>'
      + '<div><div class="cl-sum-k">' + esc(t('cl.open')) + '</div><div class="cl-sum-v">' + esc(money(c.open)) + '</div></div>'
      + '<div><div class="cl-sum-k">' + esc(t('cl.dealsN')) + '</div><div class="cl-sum-v">' + c.deals + '</div></div>'
      + '</div>'
      + (deals.length ? '<table><tbody>' + deals.map(function (d) {
        var a = Number(d.amount) || 0, p = got(d);
        var val = a ? (p > 0 && p < a ? n(p) + ' / ' + n(a) : n(a)) : (p ? n(p) : '—');
        return '<tr><td>' + esc(d.service || t('th.amount')) + '</td>'
          + '<td><span class="tag ' + ST_CLS[d.status] + '">' + esc(t('st.' + d.status)) + '</span></td>'
          + '<td class="tnum" style="font-size:12px">' + esc(dmy(d.date)) + '</td>'
          + '<td class="cell-a">' + val + '</td></tr>';
      }).join('') + '</tbody></table>' : '')
      + '<h2>' + esc(t('cl.log')) + '</h2>'
      + '<form class="row" id="fNote">'
      + '<input type="date" name="date" value="' + today() + '">'
      + '<input type="text" name="text" class="grow" placeholder="' + esc(t('cl.note')) + '" required>'
      + '<button type="submit">' + esc(t('cl.add')) + '</button></form>'
      + (notes.length ? notes.map(function (nt) {
        return '<div class="entry"><div class="entry-h"><span class="entry-d">' + esc(dmy(nt.date)) + '</span>'
          + '<button class="del" style="margin-left:auto" data-del="notes" data-id="' + esc(nt.id) + '" aria-label="' + esc(t('del')) + '">&times;</button></div>'
          + '<ul><li>' + esc(nt.text) + '</li></ul></div>';
      }).join('') : '<div class="empty">' + esc(t('cl.noLog')) + '</div>');
  }

  function renderSubs() {
    var box = $('subRows');
    if (!S.subs.length) {
      box.innerHTML = '<tr><td colspan="3" class="empty">' + t('e.subs') + '</td></tr>';
      return;
    }
    var rows = S.subs.slice().sort(function (a, b) { return b.date < a.date ? -1 : 1; });
    box.innerHTML = rows.map(function (s) {
      return '<tr><td class="tnum" style="font-size:12px">' + esc(dmy(s.date)) + '</td>'
        + '<td>' + esc(s.platform) + '</td>'
        + '<td class="cell-a">' + n(s.count)
        + ' <button class="del" data-del="subs" data-id="' + esc(s.id) + '" aria-label="' + t('del') + '">&times;</button></td></tr>';
    }).join('');
  }

  function renderPosts() {
    var box = $('postCards');
    if (!S.posts.length) { box.innerHTML = '<div class="empty">' + t('e.posts') + '</div>'; return; }
    var rubs = list(S.settings.rubrics);
    var rows = S.posts.slice().sort(function (a, b) { return b.date < a.date ? -1 : 1; });
    box.innerHTML = rows.map(function (p) {
      var i = rubs.indexOf(p.rubric);
      return '<div class="pcard">'
        + (p.rubric ? '<span class="tag ' + TAG_CLS[(i < 0 ? 0 : i) % 4] + '">' + esc(p.rubric) + '</span>' : '')
        + '<div class="pcard-t">' + (p.url ? '<a href="' + esc(p.url) + '" target="_blank" rel="noopener">' + esc(p.title) + '</a>' : esc(p.title)) + '</div>'
        + '<div class="pcard-m"><span>' + esc(p.platform || '') + '</span><span>·</span><span>' + esc(dmy(p.date)) + '</span>'
        + (Number(p.views) ? '<span>·</span><span>' + n(p.views) + ' ' + t('f.views') + '</span>' : '')
        + (Number(p.replies) ? '<span>·</span><span>' + n(p.replies) + ' ' + t('f.replies') + '</span>' : '')
        + '<button class="del" style="margin-left:auto" data-del="posts" data-id="' + esc(p.id) + '" aria-label="' + t('del') + '">&times;</button></div></div>';
    }).join('');
  }

  function renderLog() {
    var box = $('logList');
    if (!S.log.length) { box.innerHTML = '<div class="empty">' + t('e.log') + '</div>'; return; }
    var rows = S.log.slice().sort(function (a, b) { return b.date < a.date ? -1 : 1; });
    box.innerHTML = rows.map(function (e) {
      return '<div class="entry"><div class="entry-h"><span class="entry-d">' + esc(dmy(e.date)) + '</span>'
        + (e.minutes ? '<span class="entry-m">' + e.minutes + ' ' + t('min') + '</span>' : '')
        + '<button class="del" style="margin-left:auto" data-del="log" data-id="' + esc(e.id) + '" aria-label="' + t('del') + '">&times;</button></div>'
        + '<ul>' + (e.done || []).map(function (d) { return '<li>' + esc(d) + '</li>'; }).join('') + '</ul>'
        + (e.fail ? '<div class="entry-f"><b>' + t('fail') + '</b> ' + esc(e.fail) + '</div>' : '')
        + '</div>';
    }).join('');
  }

  function fillSelects() {
    var plats = list(S.settings.platforms);
    var rubs = list(S.settings.rubrics);
    function opts(arr) {
      return arr.length
        ? arr.map(function (v) { return '<option value="' + esc(v) + '">' + esc(v) + '</option>'; }).join('')
        : '<option value="">' + t('setHint') + '</option>';
    }
    // Выбранное не теряем при перерисовке — иначе смена языка сбрасывала бы форму.
    ['postPlat', 'subPlat', 'postRub'].forEach(function (id, i) {
      var el = $(id), prev = el.value;
      el.innerHTML = opts(i === 2 ? rubs : plats);
      if (prev) el.value = prev;
    });
    var ds = $('dealStatus'), prevS = ds.value;
    ds.innerHTML = STATUSES.map(function (s) {
      return '<option value="' + s + '"' + (s === 'paid' ? ' selected' : '') + '>' + t('st.' + s) + '</option>';
    }).join('');
    if (prevS) ds.value = prevS;
  }

  function render() {
    renderOverview();
    renderWeekChart();
    renderHealthChart();
    renderBoard();
    renderReports();
    renderClients();
    renderContentMetrics();
    renderMoneyChart();
    renderSubsChart();
    renderRubricChart();
    renderDeals();
    renderSubs();
    renderPosts();
    renderLog();
    fillSelects();
    var hint = $('modeHint');
    if (hint) hint.textContent = t(standalone ? 'set.modeLocal' : 'set.modeServer');
  }

  // ─── перенос данных между устройствами ─────────────────────────────
  function exportData() {
    var blob = new Blob([JSON.stringify(S, null, 2) + '\n'], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'dashboard-' + today() + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
    flag(t('exported'), 'ok');
  }

  function importData(file) {
    var fr = new FileReader();
    fr.onload = function () {
      var parsed;
      try {
        parsed = JSON.parse(fr.result);
      } catch (e) {
        return flag(t('importBad'), 'err');
      }
      // Та же проверка формы, что на сервере: кривой файл не должен затирать рабочие данные.
      if (!parsed || typeof parsed !== 'object' || !parsed.settings || !Array.isArray(parsed.deals)) {
        return flag(t('importBad'), 'err');
      }
      S = migrate(parsed);
      Array.prototype.forEach.call(document.querySelectorAll('[data-s]'), function (el) {
        el.value = S.settings[el.dataset.s] == null ? '' : S.settings[el.dataset.s];
      });
      Array.prototype.forEach.call(document.querySelectorAll('[data-p]'), function (el) {
        el.value = S.profile[el.dataset.p] == null ? '' : S.profile[el.dataset.p];
      });
      save();
    };
    fr.readAsText(file);
  }

  // ─── язык и тема ───────────────────────────────────────────────────
  function applyLang(lang) {
    L = window.I18N[lang] ? lang : 'ru';
    document.documentElement.lang = L;
    try { localStorage.setItem('lang', L); } catch (e) { /* приватный режим — просто не запоминаем */ }

    Array.prototype.forEach.call(document.querySelectorAll('[data-i18n]'), function (el) {
      el.textContent = t(el.dataset.i18n);
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-ph]'), function (el) {
      el.placeholder = t(el.dataset.ph);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.lang button'), function (b) {
      b.classList.toggle('on', b.dataset.lang === L);
    });
    $('themeL').textContent = theme() === 'dark' ? t('themeLight') : t('themeDark');
    var on = document.querySelector('.nav-i.on');
    if (on) $('barT').textContent = t('nav.' + on.dataset.v);
    if (S) render();
  }

  // Ключ намеренно theme2. Старая версия писала 'theme' при каждом запуске, поэтому
  // у всех, кто открывал дашборд раньше, там лежит 'light' — не выбор, а прошлый
  // дефолт. По старому ключу тёмная тема по умолчанию не включилась бы никогда.
  var THEME_KEY = 'theme2';

  function applyTheme(th) {
    document.documentElement.dataset.theme = th;
    $('themeL').textContent = th === 'dark' ? t('themeLight') : t('themeDark');
    try { localStorage.setItem(THEME_KEY, th); } catch (e) { /* приватный режим */ }
  }

  function boot() {
    // Тёмная тема по умолчанию; выбор пользователя, если он был, важнее.
    try { applyTheme(localStorage.getItem(THEME_KEY) || 'dark'); } catch (e) { applyTheme('dark'); }
    var saved = 'ru';
    try { saved = localStorage.getItem('lang') || 'ru'; } catch (e) { /* приватный режим */ }

    $('themeT').addEventListener('click', function () {
      applyTheme(theme() === 'dark' ? 'light' : 'dark');
      // Цвета графиков заданы в JS, а не в CSS, поэтому их надо перерисовать руками.
      renderWeekChart(); renderHealthChart();
      renderMoneyChart(); renderSubsChart(); renderRubricChart();
    });

    initDnD();

    $('clSearch').addEventListener('input', renderClients);

    // Форма записи и список клиентов пересобираются при каждой перерисовке,
    // поэтому слушаем делегированно, а не на самих элементах.
    document.addEventListener('click', function (e) {
      var b = e.target.closest('[data-cl]');
      if (!b) return;
      selClient = b.dataset.cl;
      renderClients();
    });

    document.addEventListener('submit', function (e) {
      if (e.target.id !== 'fNote') return;
      e.preventDefault();
      var f = new FormData(e.target);
      var text = String(f.get('text') || '').trim();
      if (!text) return;
      S.notes.push({ id: uid(), client: selClient, date: f.get('date') || today(), text: text });
      save();
    });

    document.querySelector('.lang').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-lang]');
      if (b) applyLang(b.dataset.lang);
    });

    document.querySelector('nav').addEventListener('click', function (e) {
      var b = e.target.closest('.nav-i');
      if (!b) return;
      Array.prototype.forEach.call(document.querySelectorAll('.nav-i'), function (x) { x.classList.toggle('on', x === b); });
      Array.prototype.forEach.call(document.querySelectorAll('.view'), function (v) { v.classList.toggle('on', v.id === 'v-' + b.dataset.v); });
      $('barT').textContent = t('nav.' + b.dataset.v);
    });

    Array.prototype.forEach.call(document.querySelectorAll('input[type=date]'), function (el) { el.value = today(); });

    $('btnExport').addEventListener('click', exportData);
    $('btnImport').addEventListener('click', function () { $('fileImport').click(); });
    $('fileImport').addEventListener('change', function (e) {
      if (e.target.files[0]) importData(e.target.files[0]);
      e.target.value = '';
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-s]'), function (el) {
      el.value = S.settings[el.dataset.s] == null ? '' : S.settings[el.dataset.s];
      el.addEventListener('input', function () {
        S.settings[el.dataset.s] = el.value;
        renderOverview(); fillSelects();
        save(true);
      });
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-p]'), function (el) {
      el.value = S.profile[el.dataset.p] || '';
      el.addEventListener('input', function () { S.profile[el.dataset.p] = el.value; save(true); });
    });

    function hook(formId, build) {
      $(formId).addEventListener('submit', function (e) {
        e.preventDefault();
        build(new FormData(e.target));
        e.target.reset();
        Array.prototype.forEach.call(e.target.querySelectorAll('input[type=date]'), function (el) { el.value = today(); });
        save();
      });
    }

    hook('fDeal', function (f) {
      var amount = Number(f.get('amount')) || 0;
      var raw = String(f.get('paid') || '').trim();
      // Поле «получено» пустое — значит смотрим на статус: оплачено целиком или ничего.
      var paid = raw === '' ? (f.get('status') === 'paid' ? amount : 0) : Number(raw) || 0;
      S.deals.push({
        id: uid(), client: f.get('client'), amount: amount, paid: paid,
        status: f.get('status'), date: f.get('date'), service: f.get('service'), url: f.get('url'),
      });
    });

    hook('fSub', function (f) {
      var date = f.get('date'), plat = f.get('platform');
      var hit = S.subs.filter(function (s) { return s.date === date && s.platform === plat; })[0];
      if (hit) hit.count = Number(f.get('count'));
      else S.subs.push({ id: uid(), date: date, platform: plat, count: Number(f.get('count')) });
    });

    hook('fPost', function (f) {
      S.posts.push({
        id: uid(), title: f.get('title'), platform: f.get('platform'), rubric: f.get('rubric'),
        date: f.get('date'), views: Number(f.get('views')) || 0, replies: Number(f.get('replies')) || 0, url: f.get('url'),
      });
    });

    hook('fLog', function (f) {
      S.log.push({
        id: uid(), date: f.get('date'), minutes: Number(f.get('minutes')) || 0,
        done: String(f.get('done')).split('\n').map(function (s) { return s.trim(); }).filter(Boolean),
        fail: String(f.get('fail') || '').trim(),
      });
    });

    document.addEventListener('click', function (e) {
      var b = e.target.closest('[data-del]');
      if (!b) return;
      S[b.dataset.del] = S[b.dataset.del].filter(function (it) { return it.id !== b.dataset.id; });
      save();
    });

    applyLang(saved);
    flag(t('loaded'));
  }

  load();
})();
