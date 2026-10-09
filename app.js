/* Путь к 100 000 AED. Источник правды — data.json, сервер пишет его целиком.
   Без ES-модулей намеренно: ?v= на <script src> не бустит импорты внутри модуля. */
(function () {
  'use strict';

  var S = null;
  var saveTimer = null;
  var charts = {};
  var $ = function (id) { return document.getElementById(id); };

  var RUB = { report: 'Отчёт', teardown: 'Разбор', dubai: 'Дубай', personal: 'Личное' };
  var ST = { lead: 'Лид', work: 'В работе', invoiced: 'Счёт', paid: 'Оплачено' };
  var ST_CLS = { lead: 't-lead', work: 't-work', invoiced: 't-inv', paid: 't-paid' };
  var PLAT = { threads: 'Threads', telegram: 'Telegram' };
  var MON = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

  var C = {
    acc: '#00E5A0', blue: '#4D7CFE', amber: '#FFB020', coral: '#FF6B4A',
    grid: 'rgba(255,255,255,.07)', tick: '#6E7682',
  };

  var n = function (v) { return Math.round(Number(v) || 0).toLocaleString('ru-RU').replace(/ /g, ' '); };
  var today = function () {
    var d = new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
  };
  var dmy = function (iso) {
    var p = String(iso || '').split('-');
    return p.length === 3 ? Number(p[2]) + ' ' + MON[Number(p[1]) - 1] : '';
  };
  var uid = function () { return Math.random().toString(36).slice(2, 10); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  function flag(text, kind) {
    var el = $('saved');
    el.textContent = text;
    el.className = 'saved' + (kind ? ' ' + kind : '');
  }

  function load() {
    fetch('/api/data', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) { S = migrate(d); boot(); })
      .catch(function (e) { flag('не читается data.json — ' + e.message, 'err'); });
  }

  // Старый файл мог быть прошлой структуры — достраиваем недостающее, ничего не теряя.
  function migrate(d) {
    d.goal = d.goal || { target: 100000, currency: 'AED', deadline: '2026-12-31', start: '2026-10-01' };
    d.profile = d.profile || {};
    d.deals = d.deals || [];
    d.subs = d.subs || [];
    d.posts = d.posts || [];
    d.log = d.log || [];
    if (d.income && d.income.length && !d.deals.length) {
      d.deals = d.income.map(function (i) {
        return { id: uid(), client: i.source, amount: i.amount, status: i.status === 'paid' ? 'paid' : 'invoiced', date: i.date, service: '', url: '' };
      });
    }
    delete d.income; delete d.channels; delete d.plan; delete d.rubrics;
    [d.deals, d.subs, d.posts, d.log].forEach(function (arr) {
      arr.forEach(function (it) { if (!it.id) it.id = uid(); });
    });
    return d;
  }

  function push() {
    return fetch('/api/data', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(S),
    }).then(function (r) {
      return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || r.status); return j; });
    });
  }

  function save(skipRender) {
    if (!skipRender) render();
    flag('…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      push().then(function () { flag('сохранено', 'ok'); })
        .catch(function (e) { flag('НЕ сохранено: ' + e.message, 'err'); });
    }, 500);
  }

  // Счётчик набирает значение — цифра должна ощущаться живой, а не подставленной.
  function countUp(el, to) {
    var from = Number(String(el.textContent).replace(/\D/g, '')) || 0;
    if (from === to) { el.textContent = n(to); return; }
    var t0 = performance.now(), dur = 900;
    (function tick(t) {
      var k = Math.min(1, (t - t0) / dur);
      var e = 1 - Math.pow(1 - k, 3);
      el.textContent = n(from + (to - from) * e);
      if (k < 1) requestAnimationFrame(tick);
    })(t0);
  }

  // Вертикальный градиент под площадь графика — рисуется по готовой области canvas.
  function fade(ctx, area, hex, top, bottom) {
    if (!area) return 'transparent';
    var g = ctx.createLinearGradient(0, area.top, 0, area.bottom);
    g.addColorStop(0, hex + top);
    g.addColorStop(1, hex + bottom);
    return g;
  }

  var glowPlugin = {
    id: 'glow',
    beforeDatasetsDraw: function (chart) {
      chart.ctx.save();
      chart.ctx.shadowColor = 'rgba(0,229,160,.45)';
      chart.ctx.shadowBlur = 18;
    },
    afterDatasetsDraw: function (chart) { chart.ctx.restore(); },
  };

  var TICK = { color: C.tick, font: { size: 11, family: "'JetBrains Mono', monospace" } };
  var TIP = {
    backgroundColor: 'rgba(12,14,18,.95)',
    borderColor: 'rgba(255,255,255,.12)',
    borderWidth: 1,
    titleColor: '#EDEFF2',
    bodyColor: '#B4BAC4',
    padding: 11,
    cornerRadius: 9,
    displayColors: false,
    titleFont: { family: "'Space Grotesk', sans-serif", size: 12 },
    bodyFont: { family: "'JetBrains Mono', monospace", size: 13 },
  };

  function drawChart(wrapId, key, emptyText, cfg) {
    var wrap = $(wrapId);
    if (charts[key]) { charts[key].destroy(); delete charts[key]; }
    if (!cfg) {
      wrap.innerHTML = '<div class="chart-empty">' + esc(emptyText) + '</div>';
      return;
    }
    wrap.innerHTML = '<div class="chart-box"><canvas id="cv-' + key + '" role="img" aria-label="'
      + esc(cfg.aria) + '">' + esc(cfg.aria) + '</canvas></div>';
    charts[key] = new Chart($('cv-' + key), cfg.chart);
  }

  function renderProgress() {
    var paid = 0, other = 0, closed = 0;
    S.deals.forEach(function (d) {
      var a = Number(d.amount) || 0;
      if (d.status === 'paid') { paid += a; closed++; } else { other += a; }
    });
    var target = S.goal.target || 100000;
    var pct = (paid / target) * 100;

    countUp($('gPaid'), paid);
    $('gPct').textContent = (pct > 0 && pct < 10 ? pct.toFixed(1) : Math.round(pct)) + '%';
    $('gBar').style.width = Math.min(100, pct) + '%';
    $('gNote').textContent = other > 0
      ? 'Ещё ' + n(other) + ' AED в работе и не оплачено'
      : (paid === 0 ? 'Ни одной оплаченной сделки' : '');

    $('mDeals').textContent = closed;
    $('mPosts').textContent = S.posts.length;
    $('mLog').textContent = S.log.length;

    // Берём последний по дате снимок каждой площадки и складываем.
    var byPlat = {};
    S.subs.slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; }).forEach(function (s) {
      byPlat[s.platform] = Number(s.count) || 0;
    });
    var total = Object.keys(byPlat).reduce(function (acc, k) { return acc + byPlat[k]; }, 0);
    $('mSubs').textContent = S.subs.length ? n(total) : '—';

    var days = Math.max(0, Math.round((new Date(S.goal.deadline) - new Date(today())) / 864e5));
    $('cDays').innerHTML = days + '<span> дней</span>';
  }

  function renderMoneyChart() {
    var paid = S.deals.filter(function (d) { return d.status === 'paid' && d.date; });
    if (!paid.length) {
      drawChart('chMoneyWrap', 'money', 'Появится с первой оплаченной сделкой');
      return;
    }
    var months = {};
    paid.forEach(function (d) {
      var k = String(d.date).slice(0, 7);
      months[k] = (months[k] || 0) + (Number(d.amount) || 0);
    });
    var keys = Object.keys(months).sort();
    drawChart('chMoneyWrap', 'money', '', {
      aria: 'Столбчатый график оплаченных сумм по месяцам',
      chart: {
        type: 'bar',
        data: {
          labels: keys.map(function (k) { return MON[Number(k.slice(5, 7)) - 1]; }),
          datasets: [{
            data: keys.map(function (k) { return months[k]; }),
            backgroundColor: function (c) { return fade(c.chart.ctx, c.chart.chartArea, C.acc, 'FF', '22'); },
            borderRadius: 7, maxBarThickness: 58,
          }],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          animation: { duration: 900, easing: 'easeOutCubic' },
          plugins: {
            legend: { display: false },
            tooltip: Object.assign({}, TIP, { callbacks: { label: function (c) { return n(c.parsed.y) + ' AED'; } } }),
          },
          scales: {
            x: { grid: { display: false }, border: { display: false }, ticks: TICK },
            y: {
              beginAtZero: true, grid: { color: C.grid, drawTicks: false }, border: { display: false },
              ticks: Object.assign({}, TICK, { callback: function (v) { return n(v); } }),
            },
          },
        },
        plugins: [glowPlugin],
      },
    });
  }

  function renderSubsChart() {
    if (S.subs.length < 2) {
      drawChart('chSubsWrap', 'subs', 'Нужно минимум два снимка, чтобы нарисовать рост');
      return;
    }
    var dates = [];
    S.subs.forEach(function (s) { if (dates.indexOf(s.date) < 0) dates.push(s.date); });
    dates.sort();
    var sets = [];
    [['threads', C.acc], ['telegram', C.blue]].forEach(function (pair, i) {
      var pts = dates.map(function (d) {
        var hit = S.subs.filter(function (s) { return s.platform === pair[0] && s.date === d; })[0];
        return hit ? Number(hit.count) || 0 : null;
      });
      if (pts.some(function (v) { return v !== null; })) {
        sets.push({
          label: PLAT[pair[0]], data: pts, spanGaps: true,
          borderColor: pair[1],
          backgroundColor: function (c) { return fade(c.chart.ctx, c.chart.chartArea, pair[1], '38', '00'); },
          fill: true,
          borderDash: i ? [6, 4] : [],
          pointStyle: i ? 'rect' : 'circle',
          pointBackgroundColor: pair[1], pointBorderColor: '#07080A', pointBorderWidth: 2,
          pointRadius: 4, pointHoverRadius: 6, borderWidth: 2.5, tension: .35,
        });
      }
    });
    drawChart('chSubsWrap', 'subs', '', {
      aria: 'Линейный график роста числа подписчиков по датам снимков',
      chart: {
        type: 'line',
        data: { labels: dates.map(dmy), datasets: sets },
        options: {
          responsive: true, maintainAspectRatio: false,
          animation: { duration: 1000, easing: 'easeOutCubic' },
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: {
              position: 'top', align: 'end',
              labels: {
                usePointStyle: true, boxWidth: 7, boxHeight: 7, padding: 18,
                color: C.tick, font: { size: 11, family: "'JetBrains Mono', monospace" },
              },
            },
            tooltip: TIP,
          },
          scales: {
            x: { grid: { display: false }, border: { display: false }, ticks: TICK },
            y: { beginAtZero: true, grid: { color: C.grid, drawTicks: false }, border: { display: false }, ticks: TICK },
          },
        },
        plugins: [glowPlugin],
      },
    });
  }

  function renderRubricChart() {
    var withViews = S.posts.filter(function (p) { return Number(p.views) > 0; });
    if (!withViews.length) {
      drawChart('chRubricWrap', 'rubric', 'Появится, когда у постов будут просмотры');
      return;
    }
    var keys = Object.keys(RUB);
    drawChart('chRubricWrap', 'rubric', '', {
      aria: 'Столбчатый график суммарных просмотров по рубрикам',
      chart: {
        type: 'bar',
        data: {
          labels: keys.map(function (k) { return RUB[k]; }),
          datasets: [{
            data: keys.map(function (k) {
              return withViews.filter(function (p) { return p.rubric === k; })
                .reduce(function (a, p) { return a + (Number(p.views) || 0); }, 0);
            }),
            backgroundColor: [C.blue, C.acc, C.amber, C.coral],
            borderRadius: 7, maxBarThickness: 26,
          }],
        },
        options: {
          indexAxis: 'y',
          responsive: true, maintainAspectRatio: false,
          animation: { duration: 900, easing: 'easeOutCubic' },
          plugins: {
            legend: { display: false },
            tooltip: Object.assign({}, TIP, { callbacks: { label: function (c) { return n(c.parsed.x) + ' просмотров'; } } }),
          },
          scales: {
            x: {
              beginAtZero: true, grid: { color: C.grid, drawTicks: false }, border: { display: false },
              ticks: Object.assign({}, TICK, { callback: function (v) { return n(v); } }),
            },
            y: { grid: { display: false }, border: { display: false }, ticks: TICK },
          },
        },
      },
    });
  }

  function renderDeals() {
    var box = $('dealRows');
    if (!S.deals.length) {
      box.innerHTML = '<tr><td colspan="5" class="empty">Ни одной сделки. Каждая сумма — с клиентом и датой.</td></tr>';
      return;
    }
    var rows = S.deals.slice().sort(function (a, b) { return (b.date || '') < (a.date || '') ? -1 : 1; });
    box.innerHTML = rows.map(function (d) {
      return '<tr><td>' + (d.url ? '<a href="' + esc(d.url) + '" target="_blank" rel="noopener">' + esc(d.client) + '</a>' : esc(d.client)) + '</td>'
        + '<td>' + esc(d.service || '') + '</td>'
        + '<td><span class="tag ' + ST_CLS[d.status] + '">' + ST[d.status] + '</span></td>'
        + '<td class="tnum" style="font-size:12px">' + esc(dmy(d.date)) + '</td>'
        + '<td class="cell-a">' + (d.amount ? n(d.amount) : '—')
        + ' <button class="del" data-del="deals" data-id="' + esc(d.id) + '" aria-label="удалить">&times;</button></td></tr>';
    }).join('');
  }

  function renderSubs() {
    var box = $('subRows');
    if (!S.subs.length) {
      box.innerHTML = '<tr><td colspan="3" class="empty">Снимков нет. Снимать раз в неделю, в один и тот же день.</td></tr>';
      return;
    }
    var rows = S.subs.slice().sort(function (a, b) { return b.date < a.date ? -1 : 1; });
    box.innerHTML = rows.map(function (s) {
      return '<tr><td class="tnum" style="font-size:12px">' + esc(dmy(s.date)) + '</td>'
        + '<td>' + (PLAT[s.platform] || '') + '</td>'
        + '<td class="cell-a">' + n(s.count)
        + ' <button class="del" data-del="subs" data-id="' + esc(s.id) + '" aria-label="удалить">&times;</button></td></tr>';
    }).join('');
  }

  function renderPosts() {
    var box = $('postCards');
    if (!S.posts.length) {
      box.innerHTML = '<div class="empty">Ни одного поста.</div>';
      return;
    }
    var rows = S.posts.slice().sort(function (a, b) { return b.date < a.date ? -1 : 1; });
    box.innerHTML = rows.map(function (p) {
      return '<div class="card"><span class="tag t-' + esc(p.rubric) + '">' + (RUB[p.rubric] || '') + '</span>'
        + '<div class="card-t">' + (p.url ? '<a href="' + esc(p.url) + '" target="_blank" rel="noopener">' + esc(p.title) + '</a>' : esc(p.title)) + '</div>'
        + '<div class="card-m"><span>' + (PLAT[p.platform] || '') + '</span><span>·</span><span>' + esc(dmy(p.date)) + '</span>'
        + (Number(p.views) ? '<span>·</span><span>' + n(p.views) + ' просм.</span>' : '')
        + (Number(p.replies) ? '<span>·</span><span>' + n(p.replies) + ' откл.</span>' : '')
        + '<button class="del" style="margin-left:auto" data-del="posts" data-id="' + esc(p.id) + '" aria-label="удалить">&times;</button></div></div>';
    }).join('');
  }

  function renderLog() {
    var box = $('logList');
    if (!S.log.length) {
      box.innerHTML = '<div class="empty">Журнал пуст.</div>';
      return;
    }
    var rows = S.log.slice().sort(function (a, b) { return b.date < a.date ? -1 : 1; });
    box.innerHTML = rows.map(function (e) {
      return '<div class="entry"><div class="entry-h"><span class="entry-d">' + esc(dmy(e.date)) + '</span>'
        + (e.minutes ? '<span class="entry-m">' + e.minutes + ' мин</span>' : '')
        + '<button class="del" style="margin-left:auto" data-del="log" data-id="' + esc(e.id) + '" aria-label="удалить">&times;</button></div>'
        + '<ul>' + (e.done || []).map(function (d) { return '<li>' + esc(d) + '</li>'; }).join('') + '</ul>'
        + (e.fail ? '<div class="entry-f"><b>Провал:</b> ' + esc(e.fail) + '</div>' : '')
        + '</div>';
    }).join('');
  }

  function render() {
    renderProgress();
    renderMoneyChart();
    renderSubsChart();
    renderRubricChart();
    renderDeals();
    renderSubs();
    renderPosts();
    renderLog();
  }

  function boot() {
    Array.prototype.forEach.call(document.querySelectorAll('input[type=date]'), function (el) { el.value = today(); });

    Array.prototype.forEach.call(document.querySelectorAll('#passport input'), function (el) {
      el.value = S.profile[el.dataset.p] || '';
      el.addEventListener('input', function () {
        S.profile[el.dataset.p] = el.value;
        save(true);
      });
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
      S.deals.push({
        id: uid(), client: f.get('client'), amount: Number(f.get('amount')) || 0,
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

    render();
    flag('data.json загружен');
  }

  load();
})();
