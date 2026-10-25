// Quick Tools remote - start an export on your own PC from your phone (PLAN Section 38, spec 2026-10-25 §1-15 v1).
// The page is a remote control: the export always runs in Revit on the PC. It talks to the Quick Tools server only
// (config.js, fetch POST text/plain JSON - no CORS preflight); each email's session comes from the 6-digit code and is
// kept in this browser's storage (the token only). DOM built with createElement / textContent - no innerHTML anywhere.
(function () {
  'use strict';

  var CFG = window.QT_CONFIG || { exec: '', version: '' };
  var STORE_SESSIONS = 'qt.remote.sessions', STORE_THEME = 'qt.remote.theme';
  var POLL_MS = 4000;
  var main = document.getElementById('main');

  // ---- small helpers -----------------------------------------------------------------------------------------

  // h('div', {cls: 'x', on: {click: f}}, child, 'text', [more]) - text always goes in as a text node.
  function h(tag, attrs) {
    var n = document.createElement(tag);
    var a = attrs || {};
    Object.keys(a).forEach(function (k) {
      var v = a[k];
      if (v === undefined || v === null || v === false) return;
      if (k === 'cls') n.className = v;
      else if (k === 'text') n.textContent = String(v);
      else if (k === 'on') Object.keys(v).forEach(function (ev) { n.addEventListener(ev, v[ev]); });
      else if (k === 'value') n.value = v;
      else if (k === 'checked') n.checked = !!v;
      else if (k === 'disabled') n.disabled = !!v;
      else n.setAttribute(k, v === true ? '' : String(v));
    });
    for (var i = 2; i < arguments.length; i++) add(n, arguments[i]);
    return n;
  }
  // add(parent, child, child, [children]) - every argument after the parent, arrays flattened.
  function add(parent) {
    for (var i = 1; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === null || c === undefined || c === false) continue;
      if (Array.isArray(c)) { c.forEach(function (x) { add(parent, x); }); continue; }
      parent.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function show() {
    clear(main);
    for (var i = 0; i < arguments.length; i++) add(main, arguments[i]);
    try { main.focus({ preventScroll: true }); } catch (e) { /* older browsers */ }
  }
  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }
  function load(key, fallback) { try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; } }
  function save(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode: kept for this visit only */ } }

  function ago(iso) {
    var t = Date.parse(iso || '');
    if (!t) return 'never';
    var s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 90) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }
  function when(iso) {
    var t = Date.parse(iso || '');
    return t ? new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
  }
  function duration(ms) {
    var s = Math.round((ms || 0) / 1000);
    if (s < 60) return s + ' s';
    var m = Math.floor(s / 60);
    return m < 60 ? m + ' min ' + (s % 60) + ' s' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
  }

  // ---- theme ---------------------------------------------------------------------------------------------------
  var themeBtn = document.getElementById('theme');
  var THEMES = ['auto', 'light', 'dark'];
  function applyTheme(t) {
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
    themeBtn.textContent = t === 'light' ? 'Light' : t === 'dark' ? 'Dark' : 'Auto';
    themeBtn.setAttribute('aria-label', 'Theme: ' + themeBtn.textContent + ' - tap to change');
  }
  var theme = load(STORE_THEME, 'auto');
  applyTheme(theme);
  themeBtn.addEventListener('click', function () {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    save(STORE_THEME, theme);
    applyTheme(theme);
  });

  // ---- connection ----------------------------------------------------------------------------------------------
  var offlineBar = document.getElementById('offline');
  function setOnline(on) { offlineBar.hidden = !!on; }
  window.addEventListener('online', function () { setOnline(true); route(); });
  window.addEventListener('offline', function () { setOnline(false); });
  setOnline(navigator.onLine !== false);

  // ---- sessions: one per email (spec §15 v1) ---------------------------------------------------------------------
  function sessions() { return load(STORE_SESSIONS, []).filter(function (s) { return s && s.email && s.session && (!s.expires || s.expires > Date.now()); }); }
  function setSessions(list) { save(STORE_SESSIONS, list); }
  function sessionOf(email) { return sessions().filter(function (s) { return s.email === email; })[0] || null; }
  function forget(email) { setSessions(sessions().filter(function (s) { return s.email !== email; })); }

  // ---- the server ------------------------------------------------------------------------------------------------
  var WORDS = {
    invalid_email: 'That is not an email address.',
    rate_limited: 'Too many codes asked for this address - wait a while, then try again.',
    no_code: 'Ask for a new code first.',
    bad_code: 'That code is not right - check the newest email.',
    too_many_attempts: 'Too many wrong codes - ask for a new one.',
    expired_code: 'That code has expired - ask for a new one.',
    remote_off: 'Remote export is not switched on for this address - ask your Quick Tools admin.',
    bad_session: 'This phone was signed out - sign in again.',
    revoked: 'Access to Quick Tools was removed for this address.',
    mail_failed: 'The code could not be sent just now - try again in a minute.',
    busy: 'The server is busy - try again in a moment.',
    not_your_pc: 'That PC is not paired with this address any more.',
    pc_offline: 'That PC is not online (not seen in the last 3 minutes). Turn it on and sign in to Windows.',
    pc_busy: 'That PC is already running a job - wait for it, or cancel it.',
    day_limit: 'That is 20 exports today from this address - the limit for a day.',
    unknown_model: 'The PC no longer lists one of these models - open the PC again.',
    unknown_sheet: 'A sheet is no longer in the PC\'s list - open the PC again.',
    no_sheets: 'Tick at least one sheet.',
    no_models: 'Tick at least one sheet.',
    unknown_profile: 'That profile is no longer on the PC.',
    unknown_folder: 'That folder is no longer one the phone may use.',
    bad_subfolder: 'The new folder must be one plain folder name - no \\ / : and not a name Windows keeps for itself.',
    bad_setting: 'A setting is not one the PC offers.',
    bad_token: 'The file name uses a {name} the PC does not list.',
    bad_profile_name: 'The new profile needs a new, plain name.',
    not_your_job: 'That job is not one of yours.',
    finished: 'That job has already ended.',
    nothing_missed: 'Nothing was missed - nothing to reprint.',
    not_finished: 'Wait for the job to end first.',
    no_registry: 'The PC has not listed its models yet - open the Exporter on it once.',
    network: 'No connection to the Quick Tools server.',
    not_set_up: 'This page is not connected to a Quick Tools server yet.'
  };
  function say(r) {
    if (!r) return WORDS.network;
    if (r.error === 'rate_limited' && r.wait) return 'One export a minute - wait ' + r.wait + ' s.';
    return WORDS[r.error] || ('The server said no (' + (r.error || 'unknown') + ').');
  }

  async function call(action, body, email) {
    if (!CFG.exec) return { ok: false, error: 'not_set_up' };
    var payload = Object.assign({ action: action }, body || {});
    if (email) {
      var s = sessionOf(email);
      if (!s) return { ok: false, error: 'bad_session' };
      payload.session = s.session;
    }
    var res;
    try {
      var r = await fetch(CFG.exec, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload), redirect: 'follow', cache: 'no-store' });
      res = await r.json();
      setOnline(true);
    } catch (e) {
      setOnline(false);
      return { ok: false, error: 'network' };
    }
    if (res && !res.ok && (res.error === 'bad_session' || res.error === 'revoked') && email) forget(email);
    return res || { ok: false, error: 'network' };
  }

  // ---- routing (#/, #/signin, #/pc/<email>/<pc>, #/job/<email>/<id>, #/history) ---------------------------------
  var timer = null;
  function stopPoll() { if (timer) { clearTimeout(timer); timer = null; } }
  function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }
  window.addEventListener('hashchange', route);
  document.addEventListener('visibilitychange', function () { if (!document.hidden && /^#\/job\//.test(location.hash)) route(); });

  function route() {
    stopPoll();
    var parts = (location.hash || '#/').replace(/^#\/?/, '').split('/').map(decodeURIComponent);
    if (!CFG.exec) return notSetUp();
    if (parts[0] === 'signin' || sessions().length === 0) return signIn(parts[0] === 'signin' && sessions().length > 0);
    if (parts[0] === 'pc' && parts[1] && parts[2]) return newJob(parts[1], parts[2]);
    if (parts[0] === 'job' && parts[1] && parts[2]) return jobView(parts[1], parts[2]);
    if (parts[0] === 'history') return history();
    return home();
  }

  function notSetUp() {
    show(h('div', { cls: 'empty card' }, h('b', { text: 'Not set up yet' }),
      'This page is not connected to a Quick Tools server yet. Your Quick Tools admin finishes it.'));
  }

  // ---- sign-in ---------------------------------------------------------------------------------------------------
  function signIn(adding) {
    var email = h('input', { type: 'email', autocomplete: 'email', inputmode: 'email', placeholder: 'you@company.com', required: true, id: 'email' });
    var err = h('div', { cls: 'error', role: 'alert' });
    var btn = h('button', { cls: 'btn block', type: 'submit', text: 'Send me a code' });
    var form = h('form', { cls: 'card pad', on: { submit: async function (ev) {
      ev.preventDefault();
      err.textContent = '';
      btn.disabled = true;
      var r = await call('r_send_code', { email: email.value.trim() });
      btn.disabled = false;
      if (!r.ok) { err.textContent = say(r); return; }
      codeStep(email.value.trim().toLowerCase());
    } } },
      h('label', { cls: 'field', for: 'email' }, h('span', { text: 'Work email' }), email),
      h('div', { cls: 'hint', text: 'The same email you sign in to Quick Tools with in Revit.' }),
      err, h('div', { cls: 'actions' }, btn));
    show(h('div', { cls: 'eyebrow', text: adding ? 'Another account' : 'Quick Tools remote' }),
      h('h1', { text: adding ? 'Add an account' : 'Export from your phone' }),
      h('p', { cls: 'lead', text: 'Start an export on your own PC and follow it to the last sheet. Revit does the work on the PC - this phone only asks.' }),
      form,
      adding ? h('div', { cls: 'actions' }, h('a', { cls: 'btn ghost', href: '#/', text: 'Back to your PCs' })) : null);
  }

  function codeStep(email) {
    var code = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9]*', maxlength: '6', cls: 'code-input', id: 'code', 'aria-label': '6-digit code' });
    var err = h('div', { cls: 'error', role: 'alert' });
    var btn = h('button', { cls: 'btn block', type: 'submit', text: 'Sign in' });
    var form = h('form', { cls: 'card pad', on: { submit: async function (ev) {
      ev.preventDefault();
      err.textContent = '';
      btn.disabled = true;
      var r = await call('r_verify', { email: email, code: code.value.trim(), device: deviceLabel() });
      btn.disabled = false;
      if (!r.ok) { err.textContent = say(r); return; }
      var list = sessions().filter(function (s) { return s.email !== r.email; });
      list.push({ email: r.email, session: r.session, expires: r.expires });
      setSessions(list);
      go('#/');
    } } },
      h('label', { cls: 'field', for: 'code' }, h('span', { text: '6-digit code' }), code), err,
      h('div', { cls: 'actions' }, btn));
    show(h('div', { cls: 'eyebrow', text: 'Check your email' }), h('h1', { text: 'Type the code' }),
      h('p', { cls: 'lead' }, 'If remote export is switched on for ', h('span', { cls: 'mono', text: email }), ', a 6-digit code is on its way. It lasts 10 minutes.'),
      form, h('div', { cls: 'actions' }, h('button', { cls: 'link-btn', type: 'button', text: 'Use another email', on: { click: function () { signIn(sessions().length > 0); } } })));
    code.focus();
  }

  function deviceLabel() {
    var ua = navigator.userAgent || '';
    var os = /iPhone|iPad/.test(ua) ? (/iPad/.test(ua) ? 'iPad' : 'iPhone') : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : 'Phone';
    var br = /Edg\//.test(ua) ? 'Edge' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'browser';
    return os + ' · ' + br;
  }

  // ---- home: PCs grouped by email --------------------------------------------------------------------------------
  async function home() {
    var list = sessions();
    show(h('div', { cls: 'eyebrow', text: 'Your PCs' }), h('h1', { text: 'Where should it export?' }), h('p', { cls: 'lead muted', text: 'Reading your PCs…' }));
    var results = await Promise.all(list.map(function (s) { return call('r_pcs', {}, s.email).then(function (r) { return { email: s.email, r: r }; }); }));
    var groups = results.map(function (g) {
      var head = h('div', { cls: 'group-head' }, h('h2', { text: g.email }),
        h('button', { cls: 'link-btn', type: 'button', text: 'Sign out this account', on: { click: async function () {
          await call('r_signout', {}, g.email);
          forget(g.email);
          route();
        } } }));
      if (!g.r.ok) return [head, h('div', { cls: 'note bad', text: say(g.r) })];
      if (!g.r.pcs.length) {
        return [head, h('div', { cls: 'card empty' }, h('b', { text: 'No PC paired with this address' }),
          'On your PC, open the Exporter in Revit, then Account › Allow remote export on this PC.')];
      }
      return [head, h('div', { cls: 'card pc-grid' }, g.r.pcs.map(function (p) { return pcRow(g.email, p); }))];
    });
    show(h('div', { cls: 'eyebrow', text: 'Your PCs' }), h('h1', { text: 'Where should it export?' }),
      h('p', { cls: 'lead', text: 'Pick a PC that is online. The export runs in a hidden Revit there - Revit may be closed.' }),
      groups,
      h('div', { cls: 'actions' },
        h('a', { cls: 'btn ghost', href: '#/history', text: 'Earlier exports' }),
        h('a', { cls: 'btn ghost', href: '#/signin', text: 'Add another account' })));
  }

  function pcRow(email, p) {
    var status = p.busy ? 'Exporting now - tap to follow' : p.online ? 'Online' : 'Last seen ' + ago(p.last_seen);
    var target = p.busy ? '#/job/' + encodeURIComponent(email) + '/' + encodeURIComponent(p.busy)
                        : '#/pc/' + encodeURIComponent(email) + '/' + encodeURIComponent(p.pc);
    var enabled = p.busy || p.online;
    return h('button', { cls: 'row', type: 'button', disabled: !enabled, 'aria-disabled': enabled ? 'false' : 'true',
      on: { click: function () { if (enabled) go(target); } } },
      h('span', { cls: 'dot' + (p.online ? ' on' : ''), 'aria-hidden': 'true' }),
      h('span', { cls: 'grow' }, h('div', { cls: 'title', text: p.name }),
        h('div', { cls: 'sub', text: status + ' · ' + plural(p.models || 0, 'model') + (p.years ? ' · Revit ' + p.years.split(',').join(', ') : '') })),
      p.busy ? h('span', { cls: 'pill accent', text: 'Busy' }) : enabled ? h('span', { cls: 'chev', text: '›', 'aria-hidden': 'true' }) : h('span', { cls: 'pill', text: 'Offline' }));
  }

  // ---- a new job: sheets, settings, folder, check (a real sequence) ----------------------------------------------
  var SETTING_KEYS = ['formats', 'pdfpaper', 'pdforient', 'pdfzoom', 'pdfzoompct', 'pdfraster', 'pdfcolors', 'pdfcombine', 'pdfcombinename', 'dwgsetup', 'dwgversion', 'pattern'];

  async function newJob(email, pc) {
    show(h('p', { cls: 'lead muted', text: 'Reading the PC\'s lists…' }));
    var r = await call('r_pc', { pc: pc }, email);
    if (!r.ok) return show(h('div', { cls: 'note bad', text: say(r) }), h('div', { cls: 'actions' }, h('a', { cls: 'btn ghost', href: '#/', text: 'Back to your PCs' })));
    if (r.busy) return go('#/job/' + encodeURIComponent(email) + '/' + encodeURIComponent(r.busy));
    var reg = r.registry || { models: [] };
    var job = { email: email, pc: pc, name: r.name, reg: reg, picks: {}, profile: (reg.profiles || [])[0] || '', changes: {}, folder: '', subfolder: '', saveAs: '', mail: true, step: 0, open: {} };
    if (!reg.models || !reg.models.length) {
      return show(h('div', { cls: 'empty card' }, h('b', { text: 'No sheet lists on this PC yet' }),
        'Open the Exporter on ' + r.name + ' and load the sheets of the models you want once - the PC remembers them for the phone.'),
        h('div', { cls: 'actions' }, h('a', { cls: 'btn ghost', href: '#/', text: 'Back to your PCs' })));
    }
    stepView(job);
  }

  function stepper(now) {
    var names = ['Sheets', 'Settings', 'Folder', 'Check'];
    return h('ol', { cls: 'steps', 'aria-label': 'Step ' + (now + 1) + ' of 4' }, names.map(function (n, i) {
      return h('li', { cls: i < now ? 'done' : i === now ? 'now' : '', text: (i + 1) + ' ' + n });
    }));
  }

  function picked(job) {
    var models = 0, sheets = 0;
    Object.keys(job.picks).forEach(function (id) { var n = job.picks[id].size; if (n) { models++; sheets += n; } });
    return { models: models, sheets: sheets };
  }

  function stepView(job) {
    var views = [sheetsStep, settingsStep, folderStep, checkStep];
    views[job.step](job);
    window.scrollTo(0, 0);
  }

  function bottom(job, nextText, nextOk, onNext) {
    var p = picked(job);
    var back = job.step === 0
      ? h('a', { cls: 'btn ghost small', href: '#/', text: 'Cancel' })
      : h('button', { cls: 'btn ghost small', type: 'button', text: 'Back', on: { click: function () { job.step--; stepView(job); } } });
    return h('div', { cls: 'stickybar' }, back,
      h('div', { cls: 'grow', text: p.sheets ? plural(p.sheets, 'sheet') + ' from ' + plural(p.models, 'model') : 'Nothing ticked yet' }),
      h('button', { cls: 'btn', type: 'button', text: nextText, disabled: !nextOk, on: { click: onNext } }));
  }

  function sheetsStep(job) {
    var reg = job.reg;
    var list = h('div', { cls: 'card' });
    function draw() {
      clear(list);
      reg.models.forEach(function (m) {
        var set = job.picks[m.id] || (job.picks[m.id] = new Set());
        var open = !!job.open[m.id];
        list.appendChild(h('button', { cls: 'row', type: 'button', 'aria-expanded': open ? 'true' : 'false',
          on: { click: function () { job.open[m.id] = !open; draw(); } } },
          h('span', { cls: 'grow' }, h('div', { cls: 'title', text: m.name }),
            h('div', { cls: 'sub', text: plural(m.sheets.length, 'sheet') + (m.cloud ? ' · ACC' : '') + ' · Revit ' + m.year })),
          set.size ? h('span', { cls: 'pill accent', text: set.size + ' ticked' }) : null,
          h('span', { cls: 'chev' + (open ? ' open' : ''), text: '›', 'aria-hidden': 'true' })));
        if (open) list.appendChild(sheetPicker(m, set, draw));
      });
      next.replaceWith(next = bottom(job, 'Next: settings', picked(job).sheets > 0, function () { job.step = 1; stepView(job); }));
    }
    var next = h('div');
    show(stepper(0), h('h1', { text: 'Which sheets?' }),
      h('p', { cls: 'lead', text: 'From the sheet lists ' + job.name + ' remembers (' + plural(reg.models.length, 'model') + (reg.total > reg.models.length ? ', the newest ' + reg.models.length + ' of ' + reg.total : '') + ').' }),
      list, next);
    draw();
  }

  function sheetPicker(m, set, redraw) {
    var box = h('div', { cls: 'picker' });
    var search = h('input', { type: 'search', placeholder: 'Search number or name', 'aria-label': 'Search sheets of ' + m.name });
    var rows = h('div');
    function shown() {
      var q = search.value.trim().toLowerCase();
      return m.sheets.filter(function (s) { return !q || (s[0] + ' ' + s[1]).toLowerCase().indexOf(q) >= 0; });
    }
    function drawRows() {
      clear(rows);
      var list = shown();
      if (!list.length) { rows.appendChild(h('div', { cls: 'empty', text: 'No sheet matches.' })); return; }
      list.forEach(function (s) {
        var id = 's-' + m.id + '-' + s[0].replace(/[^A-Za-z0-9_-]/g, '_');
        var box2 = h('input', { type: 'checkbox', id: id, checked: set.has(s[0]), on: { change: function (ev) {
          if (ev.target.checked) set.add(s[0]); else set.delete(s[0]);
          redraw();
        } } });
        var meta = [s[2] ? 'Rev ' + s[2] : '', s[3] ? 'picture ' + s[3] : ''].filter(Boolean).join(' · ');
        rows.appendChild(h('label', { cls: 'check', for: id }, box2, h('span', { cls: 'num', text: s[0] }),
          h('span', { cls: 'grow' }, h('span', { cls: 'name', text: s[1] }), meta ? h('span', { cls: 'meta', text: meta }) : null)));
      });
    }
    var all = h('button', { cls: 'btn ghost small', type: 'button', text: 'All', on: { click: function () { shown().forEach(function (s) { set.add(s[0]); }); redraw(); } } });
    var none = h('button', { cls: 'btn ghost small', type: 'button', text: 'None', on: { click: function () { shown().forEach(function (s) { set.delete(s[0]); }); redraw(); } } });
    search.addEventListener('input', drawRows);
    add(box, h('div', { cls: 'toolbar' }, search, all, none), rows);
    drawRows();
    return box;
  }

  function profileValue(job, key) {
    if (job.changes[key] !== undefined) return job.changes[key];
    var pv = (job.reg.profile_values || {})[job.profile] || {};
    return pv[key] !== undefined ? pv[key] : '';
  }

  function settingsStep(job) {
    var reg = job.reg, lists = reg.lists || {};
    var body = h('div');
    function draw() {
      clear(body);
      var profiles = reg.profiles || [];
      var sel = h('select', { id: 'profile', on: { change: function (ev) { job.profile = ev.target.value; job.changes = {}; draw(); } } },
        profiles.map(function (p) { return h('option', { value: p, text: p, selected: p === job.profile }); }));
      add(body, h('div', { cls: 'card pad' },
        h('label', { cls: 'field', for: 'profile' }, h('span', { text: 'Profile' }), sel),
        h('div', { cls: 'hint', text: 'The profile saved on the PC sets the formats, the file names and every format\'s settings. Change any of them below for this export only.' })));
      var formats = (profileValue(job, 'formats') || 'PDF').split(',').map(function (f) { return f.trim().toUpperCase(); }).filter(Boolean);
      var seg = h('div', { cls: 'seg', role: 'group', 'aria-label': 'Formats' }, (lists.formats || ['PDF', 'DWG', 'DWF', 'NWC', 'IFC']).map(function (f) {
        var on = formats.indexOf(f) >= 0;
        return h('button', { type: 'button', 'aria-pressed': on ? 'true' : 'false', text: f, on: { click: function () {
          var next = on ? formats.filter(function (x) { return x !== f; }) : formats.concat([f]);
          if (!next.length) return;
          job.changes.formats = next.join(',');
          draw();
        } } });
      }));
      var block = h('div', { cls: 'card pad' }, h('h2', { text: 'This export', style: 'margin-top:0' }), h('div', { cls: 'field' }, h('span', { text: 'Formats' }), seg));
      if (formats.indexOf('PDF') >= 0) {
        add(block, choice(job, 'pdfpaper', 'PDF paper size', lists.pdfpaper, draw), choice(job, 'pdforient', 'Orientation', lists.pdforient, draw),
          choice(job, 'pdfzoom', 'Zoom', lists.pdfzoom, draw));
        if ((profileValue(job, 'pdfzoom') || 'Zoom %') !== 'Fit to page') add(block, text(job, 'pdfzoompct', 'Zoom %', 'numeric', draw));
        add(block, choice(job, 'pdfraster', 'Raster quality', lists.pdfraster, draw), choice(job, 'pdfcolors', 'Colours', lists.pdfcolors, draw),
          toggle(job, 'pdfcombine', 'Combine all sheets into one PDF', draw));
        if (profileValue(job, 'pdfcombine') === 'true') add(block, text(job, 'pdfcombinename', 'Combined file name (blank = the model name)', 'text', draw));
      }
      if (formats.indexOf('DWG') >= 0) add(block, choice(job, 'dwgsetup', 'DWG export setup', lists.dwgsetup, draw), choice(job, 'dwgversion', 'DWG files of type', lists.dwgversion, draw));
      var pat = text(job, 'pattern', 'File name pattern (sheets)', 'text', draw);
      var toks = h('div', { cls: 'tokens', 'aria-label': 'Add a parameter' }, (lists.tokens || []).concat((lists.params || []).map(function (p) { return '{' + p + '}'; })).map(function (t) {
        return h('button', { type: 'button', text: t, on: { click: function () { job.changes.pattern = (profileValue(job, 'pattern') || '') + t; draw(); } } });
      }));
      add(block, pat, toks);
      var saveIn = h('input', { type: 'text', id: 'saveas', value: job.saveAs, placeholder: 'Optional', on: { input: function (ev) { job.saveAs = ev.target.value; check(); } } });
      var saveErr = h('div', { cls: 'error' });
      add(block, h('label', { cls: 'field', for: 'saveas' }, h('span', { text: 'Save these settings as a new profile on the PC' }), saveIn), saveErr);
      add(body, block);
      function check() {
        var e = profileNameError(job.saveAs, profiles);
        saveErr.textContent = e ? (e === 'taken' ? 'A profile with that name is on the PC already.' : 'Use a plain name - no \\ / : * ? " < > |.') : '';
        nextBar.querySelector('.btn:last-child').disabled = !!e || !job.profile;
      }
      var nextBar = bottom(job, 'Next: folder', !!job.profile, function () { job.step = 2; stepView(job); });
      add(body, nextBar);
      check();
    }
    show(stepper(1), h('h1', { text: 'How?' }), body);
    draw();
  }

  function choice(job, key, label, options, redraw) {
    if (!options || !options.length) return null;
    var cur = profileValue(job, key);
    var id = 'f-' + key;
    var opts = options.slice();
    if (cur && opts.indexOf(cur) < 0) opts.unshift(cur);
    return h('label', { cls: 'field', for: id }, h('span', { text: label }),
      h('select', { id: id, on: { change: function (ev) { job.changes[key] = ev.target.value; redraw(); } } },
        (cur ? [] : [h('option', { value: '', text: '(as the profile says)' })]).concat(opts.map(function (o) { return h('option', { value: o, text: o, selected: o === cur }); }))));
  }
  function text(job, key, label, mode, redraw) {
    var id = 'f-' + key;
    var input = h('input', { type: 'text', id: id, value: profileValue(job, key), inputmode: mode === 'numeric' ? 'numeric' : null, maxlength: '120',
      on: { change: function (ev) { job.changes[key] = ev.target.value; redraw(); } } });
    return h('label', { cls: 'field', for: id }, h('span', { text: label }), input);
  }
  function toggle(job, key, label, redraw) {
    var id = 'f-' + key;
    return h('label', { cls: 'check', for: id, style: 'padding-left:0;border-top:0' },
      h('input', { type: 'checkbox', id: id, checked: profileValue(job, key) === 'true', on: { change: function (ev) { job.changes[key] = ev.target.checked ? 'true' : 'false'; redraw(); } } }),
      h('span', { cls: 'name', text: label }));
  }

  // The server's and the PC's own rules for a name the phone sends (backend remoteSubfolderError_, CmdLogic RemoteNames).
  var RESERVED = ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9', 'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'];
  function plainNameError(s) {
    if (!s || s.trim() !== s) return 'spaces';
    if (/[\u0000-\u001f]/.test(s)) return 'control';
    if (s.indexOf('..') >= 0) return 'dots';
    if (/[\\\/]/.test(s)) return 'separator';
    if (s.indexOf(':') >= 0) return 'drive';
    if (/[<>"|?*]/.test(s)) return 'character';
    if (/[. ]$/.test(s)) return 'trailing';
    if (RESERVED.indexOf(s.split('.')[0].toUpperCase().trim()) >= 0) return 'reserved';
    return '';
  }
  function subfolderError(s) { if (!s) return ''; if (s.length > 80) return 'too_long'; return plainNameError(s); }
  function profileNameError(s, existing) {
    if (!s) return '';
    if (s.length > 60) return 'too_long';
    var e = plainNameError(s);
    if (e) return e;
    return (existing || []).some(function (p) { return p.toLowerCase() === s.toLowerCase(); }) ? 'taken' : '';
  }
  window.QT_RULES = { subfolderError: subfolderError, profileNameError: profileNameError };   // the render check runs the shared case list

  var SUB_WORDS = {
    too_long: 'At most 80 characters.', spaces: 'No space at the start or the end.', control: 'No tabs or line breaks.',
    dots: 'No "..".', separator: 'One folder only - no \\ or /.', drive: 'No drive or ":".', character: 'No < > " | ? *.',
    trailing: 'It cannot end with a dot or a space.', reserved: 'Windows keeps that name for itself.'
  };

  function folderStep(job) {
    var folders = job.reg.folders || [];
    var body = h('div');
    function draw() {
      clear(body);
      var opts = [{ id: '', label: 'The profile\'s own folder', sub: 'Wherever "' + job.profile + '" saves' }].concat(folders.map(function (f) {
        return { id: f.id, label: f.label, sub: f.onedrive ? 'In OneDrive' : 'On the PC or its network' };
      }));
      var list = h('div', { cls: 'card' }, opts.map(function (o) {
        var id = 'fo-' + (o.id || 'profile');
        return h('label', { cls: 'check', for: id },
          h('input', { type: 'radio', name: 'folder', id: id, checked: job.folder === o.id, on: { change: function () { job.folder = o.id; if (!o.id) job.subfolder = ''; draw(); } } }),
          h('span', { cls: 'grow' }, h('div', { cls: 'title', text: o.label }), h('div', { cls: 'sub', text: o.sub })));
      }));
      add(body, list);
      if (!folders.length) add(body, h('p', { cls: 'hint', text: 'To pick a folder from the phone, add it on the PC: Exporter › Account › Folders the phone may use.' }));
      var err = h('div', { cls: 'error' });
      var sub = h('input', { type: 'text', id: 'sub', value: job.subfolder, maxlength: '80', disabled: !job.folder, placeholder: job.folder ? 'Optional, for example Issue 07' : 'Pick a folder above first',
        on: { input: function (ev) { job.subfolder = ev.target.value; check(); } } });
      add(body, h('div', { cls: 'card pad', style: 'margin-top:10px' },
        h('label', { cls: 'field', for: 'sub' }, h('span', { text: 'New folder inside it' }), sub),
        h('div', { cls: 'hint', text: 'One plain folder name. The PC makes it inside the folder you picked - nowhere else.' }), err));
      var nextBar = bottom(job, 'Next: check', true, function () { job.step = 3; stepView(job); });
      add(body, nextBar);
      function check() {
        var e = subfolderError(job.subfolder);
        err.textContent = e ? SUB_WORDS[e] : '';
        nextBar.querySelector('.btn:last-child').disabled = !!e;
      }
      check();
    }
    show(stepper(2), h('h1', { text: 'Where to?' }), body);
    draw();
  }

  function folderWords(job) {
    if (!job.folder) return 'the profile\'s own folder';
    var f = (job.reg.folders || []).filter(function (x) { return x.id === job.folder; })[0];
    return (f ? f.label : 'the folder') + (job.subfolder ? ' › ' + job.subfolder : '');
  }

  function checkStep(job) {
    var p = picked(job);
    var formats = (profileValue(job, 'formats') || 'PDF').split(',').filter(Boolean).join(' + ');
    var err = h('div', { cls: 'error', role: 'alert' });
    var mail = h('input', { type: 'checkbox', id: 'mail', checked: job.mail, on: { change: function (ev) { job.mail = ev.target.checked; } } });
    var go1 = h('button', { cls: 'btn', type: 'button', text: 'Export', on: { click: async function () {
      go1.disabled = true;
      err.textContent = '';
      var settings = {};
      Object.keys(job.changes).forEach(function (k) { if (SETTING_KEYS.indexOf(k) >= 0 && job.changes[k] !== '') settings[k] = String(job.changes[k]); });
      var models = Object.keys(job.picks).filter(function (id) { return job.picks[id].size; })
        .map(function (id) { return { id: id, sheets: Array.from(job.picks[id]) }; });
      var r = await call('r_job_new', { job: { pc: job.pc, models: models, profile: job.profile, settings: settings, folder: job.folder,
        subfolder: job.subfolder, save_as: job.saveAs.trim(), mail: job.mail } }, job.email);
      go1.disabled = false;
      if (!r.ok) { err.textContent = say(r) + (r.detail ? ' (' + r.detail + ')' : ''); return; }
      go('#/job/' + encodeURIComponent(job.email) + '/' + encodeURIComponent(r.job));
    } } });
    var changed = Object.keys(job.changes).filter(function (k) { return k !== 'formats'; });
    show(stepper(3), h('h1', { text: 'Ready to export' }),
      h('div', { cls: 'card pad' },
        h('div', { cls: 'big-num', text: String(p.sheets) }),
        h('div', { cls: 'muted', text: plural(p.sheets, 'sheet') + ' · ' + plural(p.models, 'model') + ' · ' + formats }),
        h('ul', { cls: 'sheet-list' },
          h('li', null, h('span', { cls: 'num', text: 'PC' }), h('span', { text: job.name })),
          h('li', null, h('span', { cls: 'num', text: 'Profile' }), h('span', { text: job.profile + (changed.length ? ' (' + plural(changed.length, 'setting') + ' changed)' : '') })),
          h('li', null, h('span', { cls: 'num', text: 'To' }), h('span', { text: folderWords(job) })),
          job.saveAs.trim() ? h('li', null, h('span', { cls: 'num', text: 'Saved as' }), h('span', { text: 'a new profile "' + job.saveAs.trim() + '"' })) : null),
        h('label', { cls: 'check', for: 'mail', style: 'padding-left:0;border-top:0;margin-top:6px' }, mail, h('span', { cls: 'name', text: 'Email me when it ends (a summary, no files)' }))),
      err,
      h('div', { cls: 'stickybar' }, h('button', { cls: 'btn ghost small', type: 'button', text: 'Back', on: { click: function () { job.step = 2; stepView(job); } } }),
        h('div', { cls: 'grow', text: 'Runs in a hidden Revit on ' + job.name + '.' }), go1));
  }

  // ---- a job: progress, then the finish ---------------------------------------------------------------------------
  var ACTIVE = ['queued', 'claimed', 'running'];
  var STATE_WORDS = { queued: 'Waiting for the PC', claimed: 'Starting Revit on the PC', running: 'Exporting', done: 'Done', failed: 'Failed', cancelled: 'Cancelled', refused: 'Refused by the PC' };
  var MODEL_WORDS = { waiting: 'Waiting', opening: 'Opening', printing: 'Printing', done: 'Done', failed: 'Failed' };

  async function jobView(email, id) {
    var r = await call('r_job', { job: id }, email);
    if (!r.ok) return show(h('div', { cls: 'note bad', text: say(r) }), h('div', { cls: 'actions' }, h('a', { cls: 'btn ghost', href: '#/', text: 'Back to your PCs' })));
    var j = r.job;
    var active = ACTIVE.indexOf(j.state) >= 0;
    show(active ? progressView(email, j) : finishView(email, j));
    if (active && !document.hidden) timer = setTimeout(function () { if (location.hash === '#/job/' + encodeURIComponent(email) + '/' + encodeURIComponent(id)) jobView(email, id); }, POLL_MS);
  }

  function strip(sheets) {
    return h('div', { cls: 'strip', 'aria-hidden': 'true' }, sheets.map(function (s) { return h('span', { cls: 'sheet ' + (s.s || 'waiting'), title: (s.f ? s.f + ' ' : '') + s.n }); }));
  }

  function progressView(email, j) {
    var pr = j.progress || {};
    var pct = Math.max(0, Math.min(100, pr.percent || 0));
    var models = pr.models || [];
    var sheets = pr.sheets || [];
    var cancel = h('button', { cls: 'btn danger', type: 'button', text: j.cancel ? 'Stopping…' : 'Cancel export', disabled: j.cancel });
    var armed = false;
    cancel.addEventListener('click', async function () {
      if (!armed) { armed = true; cancel.textContent = 'Tap again to cancel'; return; }
      cancel.disabled = true;
      var r = await call('r_cancel', { job: j.id }, email);
      cancel.textContent = r.ok ? 'Stopping…' : say(r);
      route();
    });
    return [
      h('div', { cls: 'eyebrow', text: j.pc_name }),
      h('h1', { text: STATE_WORDS[j.state] + (j.cancel ? ' - stopping' : '') }),
      h('p', { cls: 'lead', text: j.profile + ' · ' + plural(j.sheets, 'sheet') + ' · ' + plural(j.models, 'model') + ' · started ' + ago(j.created) }),
      h('div', { cls: 'card pad' },
        h('div', { cls: 'stat-line' }, h('div', null, h('b', { text: pct + ' %' }), 'done'), h('div', null, h('b', { text: String(pr.files || 0) }), 'files written'),
          h('div', null, h('b', { text: j.updated ? ago(j.updated) : '-' }), 'last word from the PC')),
        h('div', { cls: 'meter', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct) }, h('i', { style: 'width:' + pct + '%' }))),
      models.length ? models.map(function (m) {
        var mine = sheets.filter(function (s) { return s.m === m.id; });
        return h('div', { cls: 'card pad' },
          h('div', { style: 'display:flex;justify-content:space-between;gap:8px;align-items:baseline' }, h('b', { text: m.name }),
            h('span', { cls: 'pill ' + (m.state === 'done' ? 'good' : m.state === 'failed' ? 'bad' : m.state === 'waiting' ? '' : 'accent'),
              text: MODEL_WORDS[m.state] + (m.state === 'printing' || m.state === 'done' ? ' ' + (m.done || 0) + ' of ' + (m.total || 0) : '') })),
          mine.length ? strip(mine) : null,
          mine.length ? h('details', null, h('summary', { text: 'Sheets' }), h('ul', { cls: 'sheet-list' }, mine.map(function (s) {
            return h('li', null, h('span', { cls: 'num', text: s.n }), h('span', { cls: 'grow', text: s.name }), h('span', { cls: 'muted', text: s.f + ' · ' + s.s }));
          }))) : null);
      }) : h('div', { cls: 'card empty' }, h('b', { text: j.state === 'queued' ? 'Waiting for ' + j.pc_name : 'Revit is starting on ' + j.pc_name }),
        j.state === 'queued' ? 'The PC asks every 2 minutes.' : 'A hidden Revit opens the first model - this can take a minute or two.'),
      h('div', { cls: 'actions' }, cancel, h('a', { cls: 'btn ghost', href: '#/', text: 'Your PCs' }))
    ];
  }

  function finishView(email, j) {
    var s = j.summary || {};
    var missed = s.missed || [];
    var tone = j.state === 'done' ? (missed.length ? 'warn' : 'good') : 'bad';
    var reprint = h('button', { cls: 'btn', type: 'button', text: 'Reprint missed (' + missed.length + ')', on: { click: async function () {
      reprint.disabled = true;
      var r = await call('r_reprint', { job: j.id }, email);
      if (!r.ok) { reprint.disabled = false; reprint.textContent = say(r); return; }
      go('#/job/' + encodeURIComponent(email) + '/' + encodeURIComponent(r.job));
    } } });
    var byModel = {};
    missed.forEach(function (m) { (byModel[m.name || m.model] = byModel[m.name || m.model] || []).push(m); });
    var od = s.onedrive && s.onedrive.path ? s.onedrive : null;
    var copyBtn = od ? h('button', { cls: 'btn ghost small', type: 'button', text: 'Copy path', on: { click: function () {
      var t = 'OneDrive/' + od.path;
      if (navigator.clipboard) navigator.clipboard.writeText(t).then(function () { copyBtn.textContent = 'Copied'; }, function () { copyBtn.textContent = t; });
      else copyBtn.textContent = t;
    } } }) : null;
    return [
      h('div', { cls: 'eyebrow', text: j.pc_name + ' · ' + when(j.finished || j.updated) }),
      h('h1', { text: s.headline || STATE_WORDS[j.state] }),
      h('div', { cls: 'card pad' },
        h('span', { cls: 'pill ' + tone, text: STATE_WORDS[j.state] }),
        h('div', { cls: 'stat-line' }, h('div', null, h('b', { text: String(s.files || 0) }), 'files written'),
          h('div', null, h('b', { text: String(missed.length) }), 'sheets missed'),
          s.ms ? h('div', null, h('b', { text: duration(s.ms) }), 'on the PC') : null),
        s.folder ? h('p', { cls: 'hint', text: 'Saved in ' + s.folder + (s.report ? ' · the report: ' + s.report : '') }) : null),
      od ? h('div', { cls: 'card pad' },
        h('b', { text: 'In OneDrive' }), h('p', { cls: 'mono', text: od.path, style: 'margin:6px 0 10px;word-break:break-all' }),
        h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' },
          od.web ? h('a', { cls: 'btn small', href: od.web, target: '_blank', rel: 'noopener noreferrer', text: 'Open in OneDrive' }) : null, copyBtn)) : null,
      missed.length ? h('div', { cls: 'card pad' }, h('b', { text: 'Not written' }), Object.keys(byModel).map(function (name) {
        return h('div', null, h('div', { cls: 'muted', style: 'margin-top:10px', text: name }), h('ul', { cls: 'sheet-list' }, byModel[name].map(function (m) {
          return h('li', null, h('span', { cls: 'num', text: m.number }), h('span', { cls: 'grow' }, h('div', { text: m.sheet || '' }), h('div', { cls: 'why', text: m.format + ' · ' + m.why })));
        })));
      })) : null,
      h('div', { cls: 'actions' }, missed.length ? reprint : null, h('a', { cls: 'btn ghost', href: '#/', text: 'Your PCs' }), h('a', { cls: 'btn ghost', href: '#/history', text: 'Earlier exports' }))
    ];
  }

  // ---- history -------------------------------------------------------------------------------------------------
  async function history() {
    show(h('p', { cls: 'lead muted', text: 'Reading your exports…' }));
    var list = sessions();
    var results = await Promise.all(list.map(function (s) { return call('r_jobs', { limit: 30 }, s.email).then(function (r) { return { email: s.email, r: r }; }); }));
    var rows = [];
    var problems = [];
    results.forEach(function (g) {
      if (!g.r.ok) { problems.push(g.email + ': ' + say(g.r)); return; }
      g.r.jobs.forEach(function (j) { rows.push({ email: g.email, j: j }); });
    });
    rows.sort(function (a, b) { return (Date.parse(b.j.created) || 0) - (Date.parse(a.j.created) || 0); });
    var tones = { done: 'good', failed: 'bad', refused: 'bad', cancelled: '', queued: 'accent', claimed: 'accent', running: 'accent' };
    show(h('div', { cls: 'eyebrow', text: 'History' }), h('h1', { text: 'Earlier exports' }),
      problems.map(function (p) { return h('div', { cls: 'note bad', text: p }); }),
      rows.length ? h('div', { cls: 'card' }, rows.map(function (x) {
        var j = x.j, s = j.summary;
        return h('button', { cls: 'row', type: 'button', on: { click: function () { go('#/job/' + encodeURIComponent(x.email) + '/' + encodeURIComponent(j.id)); } } },
          h('span', { cls: 'grow' }, h('div', { cls: 'title', text: j.pc_name + ' · ' + j.profile }),
            h('div', { cls: 'sub', text: when(j.created) + ' · ' + plural(j.sheets, 'sheet') + (s ? ' · ' + (s.files || 0) + ' files' + (s.missed ? ', ' + s.missed + ' missed' : '') : '') + (list.length > 1 ? ' · ' + x.email : '') })),
          h('span', { cls: 'pill ' + (tones[j.state] || ''), text: STATE_WORDS[j.state] || j.state }));
      })) : h('div', { cls: 'card empty' }, h('b', { text: 'No export yet' }), 'Pick a PC and start one.'),
      h('div', { cls: 'actions' }, h('a', { cls: 'btn ghost', href: '#/', text: 'Your PCs' })));
  }

  // ---- start -------------------------------------------------------------------------------------------------------
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () { /* the page works without it */ }); });
  }
  route();
})();
