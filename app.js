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

  var STATUSES = ['lead', 'work', 'invoiced', 'paid'];
  var ST_CLS = { lead: 't-lead', work: 't-work', invoiced: 't-inv', paid: 't-paid' };
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
  var today = function () {
    var d = new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
  };
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
    return { meta: { version: 3 }, settings: {}, profile: {}, deals: [], subs: [], posts: [], log: [] };
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

    [d.deals, d.subs, d.posts, d.log].forEach(function (arr) {
      arr.forEach(function (it) { if (!it.id) it.id = uid(); });
    });
    // До появления частичной оплаты «получено» значило всю сумму сразу.
    d.deals.forEach(function (x) {
      if (x.paid == null) x.paid = x.status === 'paid' ? Number(x.amount) || 0 : 0;
    });
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

  function countUp(el, to) {
    var from = Number(String(el.textContent).replace(/[^\d]/g, '')) || 0;
    // В скрытой вкладке requestAnimationFrame не вызывается — анимация замерла бы
    // на начальном значении и показывала неверную сумму. Там ставим итог сразу.
    if (from === to || document.hidden) { el.textContent = n(to); return; }
    var t0 = performance.now(), dur = 800;
    (function tick(ts) {
      var k = Math.min(1, (ts - t0) / dur);
      el.textContent = n(from + (to - from) * (1 - Math.pow(1 - k, 3)));
      if (k < 1) requestAnimationFrame(tick);
    })(t0);
  }

  // ─── графики ───────────────────────────────────────────────────────
  function theme() { return document.documentElement.dataset.theme; }
  function palette() {
    var dark = theme() === 'dark';
    return {
      acc: '#FF752A',
      green: dark ? '#4DAB9A' : '#0F7B5F',
      amber: dark ? '#D9A441' : '#C08A2E',
      purple: dark ? '#9A6DD7' : '#6940A5',
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

  // ─── блоки ─────────────────────────────────────────────────────────
  function renderOverview() {
    var title = (S.settings.title || '').trim();
    $('ovTitle').textContent = title || t('nav.overview');
    $('ovSub').textContent = (S.settings.subtitle || '').trim();
    $('ovSub').style.display = S.settings.subtitle ? '' : 'none';
    $('brandT').textContent = title || 'Dark Fusion';
    $('crumb').textContent = title || t('dashboard');
    document.title = title ? title + ' · Dark Fusion' : 'Dark Fusion Dashboard';

    // Сделка живёт одной строкой: amount — вся стоимость, paid — сколько пришло.
    // Предоплата 50 % не плодит второй сделки, поэтому в списке нет дублей.
    var paid = 0, work = 0, closed = 0;
    S.deals.forEach(function (d) {
      var a = Number(d.amount) || 0, p = got(d);
      paid += p;
      work += Math.max(0, a - p);
      if (p > 0) closed++;
    });

    countUp($('mPaid'), paid);
    $('mPaidS').textContent = closed ? closed + ' ' + plural(closed) : t('m.nothing');
    $('mWork').textContent = n(work);
    $('mPosts').textContent = S.posts.length;

    var byPlat = {};
    S.subs.slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; }).forEach(function (s) {
      byPlat[s.platform] = Number(s.count) || 0;
    });
    var totalSubs = Object.keys(byPlat).reduce(function (a, k) { return a + byPlat[k]; }, 0);
    $('mSubs').textContent = S.subs.length ? n(totalSubs) : '—';
    $('mSubsS').textContent = S.subs.length ? Object.keys(byPlat).join(' + ') : t('m.noSnaps');

    // Блок цели рисуется только если цель задана — иначе его просто нет.
    var goal = Number(S.settings.goal) || 0;
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
    $('cPosts').textContent = S.posts.length || '';
    $('cLog').textContent = S.log.length || '';
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

  function applyTheme(th) {
    document.documentElement.dataset.theme = th;
    $('themeL').textContent = th === 'dark' ? t('themeLight') : t('themeDark');
    try { localStorage.setItem('theme', th); } catch (e) { /* приватный режим */ }
  }

  function boot() {
    try { applyTheme(localStorage.getItem('theme') || 'light'); } catch (e) { applyTheme('light'); }
    var saved = 'ru';
    try { saved = localStorage.getItem('lang') || 'ru'; } catch (e) { /* приватный режим */ }

    $('themeT').addEventListener('click', function () {
      applyTheme(theme() === 'dark' ? 'light' : 'dark');
      renderMoneyChart(); renderSubsChart(); renderRubricChart();
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
