/* Дашборд канала. Источник правды — data.json на диске, сервер пишет его целиком.
   Без ES-модулей намеренно: ?v= на <script src> не бустит импорты внутри модуля. */
(function () {
  'use strict';

  var S = null;              // данные
  var saveTimer = null;
  var $ = function (id) { return document.getElementById(id); };

  var AED = function (n) {
    return Math.round(n).toLocaleString('ru-RU').replace(/ /g, ' ');
  };
  var today = function () {
    var d = new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
  };
  var days = function (a, b) {
    return Math.round((new Date(b) - new Date(a)) / 864e5);
  };
  var dmy = function (iso) {
    var p = String(iso).split('-');
    return p.length === 3 ? p[2] + '.' + p[1] : iso;
  };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  // ─── загрузка и запись ───────────────────────────────────────────────
  function load() {
    fetch('/api/data', { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (d) { S = d; boot(); })
      .catch(function (e) {
        flag('не читается data.json — ' + e.message, 'err');
      });
  }

  function flag(text, kind) {
    var el = $('saved');
    el.textContent = text;
    el.className = 'saved' + (kind ? ' is-' + kind : '');
  }

  // Пишем с задержкой: подряд поставленные галочки уходят одним запросом.
  function save() {
    render();
    flag('…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      fetch('/api/data', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(S),
      })
        .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || r.status); return j; }); })
        .then(function () { flag('сохранено в data.json', 'ok'); })
        .catch(function (e) { flag('НЕ сохранено: ' + e.message, 'err'); });
    }, 400);
  }

  // ─── цель ───────────────────────────────────────────────────────────
  function renderGoal() {
    var g = S.goal;
    var paid = 0, signed = 0;
    S.income.forEach(function (i) {
      if (i.status === 'paid') paid += Number(i.amount) || 0;
      else signed += Number(i.amount) || 0;
    });

    var pct = g.target > 0 ? (paid / g.target) * 100 : 0;
    $('gPct').textContent = (pct < 10 ? pct.toFixed(1) : Math.round(pct)) + '%';
    $('gBar').style.width = Math.min(100, pct) + '%';
    $('gEarned').textContent = AED(paid) + ' ' + g.currency;
    $('gTarget').textContent = AED(g.target) + ' ' + g.currency;

    var left = Math.max(0, g.target - paid);
    $('gLeft').textContent = AED(left);
    $('gLeftSub').textContent = signed > 0
      ? 'из них ' + AED(signed) + ' уже согласовано'
      : g.currency;

    var dLeft = Math.max(0, days(today(), g.deadline));
    $('gDays').textContent = dLeft;
    $('gDaysSub').textContent = 'дедлайн ' + dmy(g.deadline) + '.2026';
    $('gPace').textContent = dLeft > 0 ? AED(left / dLeft) : '—';

    var elapsed = Math.max(1, days(g.start, today()));
    var real = paid / elapsed;
    $('gReal').textContent = AED(real);
    if (paid === 0) {
      $('gRealSub').textContent = 'ни одного поступления';
    } else {
      var forecast = paid + real * dLeft;
      $('gRealSub').textContent = 'к 31.12 выйдет ' + AED(forecast) + ' при этом темпе';
    }

    var box = $('incomeList');
    if (!S.income.length) {
      box.innerHTML = '<div class="empty">Пусто. Каждое поступление — строкой, чтобы цифра в отчёте была прослеживаемой.</div>';
      return;
    }
    var rows = S.income.slice().sort(function (a, b) { return b.date < a.date ? -1 : 1; });
    box.innerHTML = rows.map(function (i) {
      return '<div class="item"><span class="d">' + esc(dmy(i.date)) + '</span>'
        + '<span class="t">' + esc(i.source)
        + (i.status === 'signed' ? ' <span class="pill signed">согласовано</span>' : '')
        + '</span>'
        + '<span class="a">' + AED(i.amount) + '</span>'
        + '<button class="del" data-del="income" data-id="' + esc(i.date + '|' + i.amount + '|' + i.source) + '" title="удалить">&times;</button></div>';
    }).join('');
  }

  // ─── канал ──────────────────────────────────────────────────────────
  function sparkline(snaps) {
    if (snaps.length < 2) return '';
    var vals = snaps.map(function (s) { return Number(s.subs) || 0; });
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    var span = max - min || 1;
    var W = 260, H = 40;
    var pts = vals.map(function (v, i) {
      return [
        (i / (vals.length - 1)) * W,
        H - ((v - min) / span) * H,
      ];
    });
    var d = pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ');
    return '<svg class="spark" viewBox="-2 -2 ' + (W + 4) + ' ' + (H + 4) + '" preserveAspectRatio="none">'
      + '<path d="' + d + '"/></svg>';
  }

  function renderChannel() {
    var box = $('chCards');
    box.innerHTML = Object.keys(S.channels).map(function (key) {
      var c = S.channels[key];
      var snaps = (c.snapshots || []).slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; });
      var last = snaps[snaps.length - 1];
      var prev = snaps[snaps.length - 2];
      var growth = '';
      if (last && prev) {
        var diff = (Number(last.subs) || 0) - (Number(prev.subs) || 0);
        growth = '<div class="ch-g' + (diff > 0 ? ' up' : '') + '">'
          + (diff > 0 ? '+' : '') + diff + ' с ' + dmy(prev.date) + '</div>';
      } else if (last) {
        growth = '<div class="ch-g">первый снимок ' + dmy(last.date) + '</div>';
      } else {
        growth = '<div class="ch-g">снимков нет</div>';
      }
      var posts = S.posts.filter(function (p) { return p.platform === key; }).length;
      return '<div class="card">'
        + '<div class="ch-h"><span class="nm">' + esc(c.label) + '</span>'
        + '<span class="hd">' + (c.handle ? esc(c.handle) : '') + '</span></div>'
        + '<div class="ch-v">' + (last ? AED(last.subs) : '—') + '</div>'
        + growth
        + sparkline(snaps)
        + '<div class="ch-g" style="margin-top:8px">постов: ' + posts + '</div>'
        + '</div>';
    }).join('');

    var pl = $('postList');
    if (!S.posts.length) {
      pl.innerHTML = '<div class="empty">Ни одного поста. Первые три — в один день, чтобы зашедший не увидел пустой канал.</div>';
      return;
    }
    var rub = {};
    (S.rubrics || []).forEach(function (r) { rub[r.key] = r; });
    var rows = S.posts.slice().sort(function (a, b) { return b.date < a.date ? -1 : 1; });
    pl.innerHTML = rows.map(function (p, idx) {
      var r = rub[p.rubric];
      return '<div class="item"><span class="d">' + esc(dmy(p.date)) + '</span>'
        + '<span class="t">'
        + (r ? '<span class="pill" style="background:' + esc(r.color) + '1A;color:' + esc(r.color) + '">' + esc(r.label) + '</span> ' : '')
        + esc(p.title)
        + ' <span class="pill">' + esc(S.channels[p.platform] ? S.channels[p.platform].label : p.platform) + '</span>'
        + '</span>'
        + '<span class="a">' + (p.views ? AED(p.views) : '—') + '</span>'
        + '<button class="del" data-del="post" data-i="' + idx + '" title="удалить">&times;</button></div>';
    }).join('');
  }

  // ─── журнал ─────────────────────────────────────────────────────────
  function renderJournal() {
    var box = $('logList');
    if (!S.log.length) {
      box.innerHTML = '<div class="empty">Журнал пуст.</div>';
      return;
    }
    var rows = S.log.slice().sort(function (a, b) { return b.date < a.date ? -1 : 1; });
    box.innerHTML = rows.map(function (e, idx) {
      var items = (e.done || []).map(function (d) { return '<li>' + esc(d) + '</li>'; }).join('');
      return '<div class="entry">'
        + '<div class="entry-h"><span class="date">' + esc(dmy(e.date)) + '</span>'
        + (e.minutes ? '<span class="mins">' + e.minutes + ' мин в работе</span>' : '')
        + '<button class="del" style="opacity:1;margin-left:auto" data-del="log" data-i="' + idx + '">&times;</button></div>'
        + '<ul>' + items + '</ul>'
        + (e.fail ? '<div class="fail"><b>Провал:</b> ' + esc(e.fail) + '</div>' : '')
        + '</div>';
    }).join('');
  }

  // ─── план ───────────────────────────────────────────────────────────
  function renderPlan() {
    var total = 0, done = 0;
    S.plan.forEach(function (t) {
      var w = Number(t.weight) || 1;
      total += w;
      if (t.done) done += w;
    });
    var pct = total ? (done / total) * 100 : 0;
    $('pPct').textContent = Math.round(pct) + '%';
    $('pBar').style.width = pct + '%';
    $('pDone').textContent = 'закрыто ' + done + ' из ' + total + ' по весу';
    $('pLeft').textContent = 'осталось ' + (100 - Math.round(pct)) + '%';

    var groups = [];
    S.plan.forEach(function (t) { if (groups.indexOf(t.group) < 0) groups.push(t.group); });
    $('planGroups').innerHTML = groups.map(function (g) { return '<option value="' + esc(g) + '">'; }).join('');

    $('planList').innerHTML = groups.map(function (g) {
      var tasks = S.plan.filter(function (t) { return t.group === g; });
      return '<div class="pgroup"><h3>' + esc(g) + '</h3>' + tasks.map(function (t) {
        return '<label class="ptask' + (t.done ? ' done' : '') + '">'
          + '<input type="checkbox" data-task="' + esc(t.id) + '"' + (t.done ? ' checked' : '') + '>'
          + '<span class="pt">' + esc(t.title) + '</span>'
          + '<span class="w">×' + (Number(t.weight) || 1) + '</span>'
          + '</label>';
      }).join('') + '</div>';
    }).join('');
  }

  function render() {
    renderGoal();
    renderChannel();
    renderJournal();
    renderPlan();
  }

  // ─── события ────────────────────────────────────────────────────────
  function boot() {
    $('deadline').textContent = 'до 31 декабря · ' + Math.max(0, days(today(), S.goal.deadline)) + ' дней';

    $('fPostRubric').innerHTML = (S.rubrics || []).map(function (r) {
      return '<option value="' + esc(r.key) + '">' + esc(r.label) + '</option>';
    }).join('');

    Array.prototype.forEach.call(document.querySelectorAll('input[type=date]'), function (el) {
      el.value = today();
    });

    document.querySelector('.tabs').addEventListener('click', function (e) {
      var b = e.target.closest('.tab');
      if (!b) return;
      Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) { t.classList.toggle('is-on', t === b); });
      Array.prototype.forEach.call(document.querySelectorAll('.view'), function (v) {
        v.classList.toggle('is-on', v.id === 'v-' + b.dataset.tab);
      });
    });

    $('fIncome').addEventListener('submit', function (e) {
      e.preventDefault();
      var f = new FormData(e.target);
      S.income.push({
        date: f.get('date'),
        amount: Number(f.get('amount')),
        source: f.get('source'),
        status: f.get('status'),
      });
      e.target.reset();
      e.target.querySelector('input[type=date]').value = today();
      save();
    });

    $('fSnap').addEventListener('submit', function (e) {
      e.preventDefault();
      var f = new FormData(e.target);
      var ch = S.channels[f.get('platform')];
      ch.snapshots = ch.snapshots || [];
      var date = f.get('date');
      var existing = ch.snapshots.filter(function (s) { return s.date === date; })[0];
      if (existing) existing.subs = Number(f.get('subs'));
      else ch.snapshots.push({ date: date, subs: Number(f.get('subs')) });
      e.target.reset();
      e.target.querySelector('input[type=date]').value = today();
      save();
    });

    $('fPost').addEventListener('submit', function (e) {
      e.preventDefault();
      var f = new FormData(e.target);
      S.posts.push({
        date: f.get('date'),
        platform: f.get('platform'),
        rubric: f.get('rubric'),
        title: f.get('title'),
        views: Number(f.get('views')) || 0,
      });
      e.target.reset();
      e.target.querySelector('input[type=date]').value = today();
      save();
    });

    $('fLog').addEventListener('submit', function (e) {
      e.preventDefault();
      var f = new FormData(e.target);
      S.log.push({
        date: f.get('date'),
        minutes: Number(f.get('minutes')) || 0,
        done: String(f.get('done')).split('\n').map(function (s) { return s.trim(); }).filter(Boolean),
        fail: String(f.get('fail') || '').trim(),
      });
      e.target.reset();
      e.target.querySelector('input[type=date]').value = today();
      save();
    });

    $('fPlan').addEventListener('submit', function (e) {
      e.preventDefault();
      var f = new FormData(e.target);
      S.plan.push({
        id: 'u-' + Math.random().toString(36).slice(2, 8),
        group: f.get('group'),
        title: f.get('title'),
        weight: Number(f.get('weight')),
        done: false,
      });
      e.target.reset();
      save();
    });

    document.addEventListener('change', function (e) {
      var cb = e.target.closest('input[data-task]');
      if (!cb) return;
      S.plan.forEach(function (t) { if (t.id === cb.dataset.task) t.done = cb.checked; });
      save();
    });

    document.addEventListener('click', function (e) {
      var b = e.target.closest('[data-del]');
      if (!b) return;
      var kind = b.dataset.del;
      if (kind === 'income') {
        var key = b.dataset.id;
        S.income = S.income.filter(function (i) { return i.date + '|' + i.amount + '|' + i.source !== key; });
      } else if (kind === 'post') {
        var sorted = S.posts.slice().sort(function (a, c) { return c.date < a.date ? -1 : 1; });
        var victim = sorted[Number(b.dataset.i)];
        S.posts = S.posts.filter(function (p) { return p !== victim; });
      } else if (kind === 'log') {
        var ls = S.log.slice().sort(function (a, c) { return c.date < a.date ? -1 : 1; });
        var lv = ls[Number(b.dataset.i)];
        S.log = S.log.filter(function (l) { return l !== lv; });
      }
      save();
    });

    render();
    flag('data.json загружен');
  }

  load();
})();
