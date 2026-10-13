/* =====================================================================
   Chai Khata — application logic (vanilla JS, no build step)
   Security note: this file only talks to Supabase with the publishable key and
   the signed-in user's session. All permissions are enforced by Row Level
   Security and SECURITY DEFINER functions in supabase-setup.sql.
   ===================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Constants & state                                                   */
  /* ------------------------------------------------------------------ */
  var TZ = 'Asia/Kolkata';
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var PAY_METHODS = ['Cash', 'UPI', 'Other'];
  var MAX_AMOUNT = 1000000;
  var SESSION_MSG = 'Your session has expired. Please sign in again.';

  var OWNER_NAV = [
    { id: 'dashboard', label: 'Dashboard', icon: '🏠', bottom: true },
    { id: 'entry', label: 'New Entry', icon: '➕', bottom: true },
    { id: 'customers', label: 'Customers', icon: '👥', bottom: true },
    { id: 'transactions', label: 'Transactions', icon: '🧾', bottom: true },
    { id: 'products', label: 'Products', icon: '☕' },
    { id: 'reports', label: 'Reports', icon: '📊' },
    { id: 'settings', label: 'Settings', icon: '⚙️' }
  ];
  var CUSTOMER_NAV = [
    { id: 'home', label: 'Home', icon: '🏠', bottom: true },
    { id: 'ledger', label: 'Ledger', icon: '📒', bottom: true },
    { id: 'profile', label: 'Profile', icon: '👤', bottom: true }
  ];

  var TX_SELECT = '*, customer:profiles!transactions_customer_id_fkey(full_name,mobile), transaction_items(id,product_name,quantity,unit_price,line_total)';

  var state = {
    profile: null,
    stall: null,
    customers: [],
    products: [],
    renderToken: 0,
    recovery: false,
    loginFails: 0,
    lockUntil: 0
  };

  var entry = {
    tab: 'purchase',
    customerId: null,
    cart: new Map(),
    note: '',
    sigs: {},
    ids: {}
  };

  /* ------------------------------------------------------------------ */
  /* Small helpers                                                       */
  /* ------------------------------------------------------------------ */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var moneyFmt = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  function money(n) { return moneyFmt.format(Number(n) || 0); }
  function num(q) { return String(Number(q)); }
  function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

  function dtParts(ts, opts) {
    var out = {};
    new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: TZ }, opts)).formatToParts(new Date(ts)).forEach(function (p) { out[p.type] = p.value; });
    return out;
  }
  function fmtDate(ts) {
    if (!ts) return '—';
    var p = dtParts(ts, { day: '2-digit', month: 'short', year: 'numeric' });
    return p.day + ' ' + p.month + ' ' + p.year;
  }
  function fmtTime(ts) {
    if (!ts) return '';
    var p = dtParts(ts, { hour: '2-digit', minute: '2-digit', hour12: true });
    return p.hour + ':' + p.minute + ' ' + (p.dayPeriod || '').toUpperCase();
  }
  function fmtISODate(iso) {
    if (!iso) return '—';
    var a = iso.split('-');
    return a[2] + ' ' + MONTHS[Number(a[1]) - 1] + ' ' + a[0];
  }
  function todayISO() { return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date()); }
  function addDays(iso, n) {
    var a = iso.split('-').map(Number);
    var d = new Date(Date.UTC(a[0], a[1] - 1, a[2] + n));
    return d.toISOString().slice(0, 10);
  }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }
  function debounce(fn, ms) {
    var t;
    return function () { var a = arguments, ctx = this; clearTimeout(t); t = setTimeout(function () { fn.apply(ctx, a); }, ms); };
  }
  function normalizeMobile(raw) {
    var d = String(raw || '').replace(/\D/g, '');
    if (d.length === 12 && d.indexOf('91') === 0) d = d.slice(2);
    else if (d.length === 11 && d.indexOf('0') === 0) d = d.slice(1);
    return /^[6-9][0-9]{9}$/.test(d) ? d : null;
  }
  // first 3 letters (a-z) of first name + first 4 digits of mobile — mirrors the Edge Function
  function initialPassword(name, mobile) {
    var first = String(name || '').trim().split(/\s+/)[0] || '';
    var letters = first.toLowerCase().replace(/[^a-z]/g, '');
    return (letters + 'xxx').slice(0, 3) + String(mobile || '').slice(0, 4);
  }
  function parseAmount(str) {
    var s = String(str == null ? '' : str).replace(/,/g, '').trim();
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
    var n = Number(s);
    return n >= 0.01 && n <= MAX_AMOUNT ? n : NaN;
  }
  function isOwner() { return state.profile && state.profile.role === 'owner'; }
  function balClass(b) { b = Number(b); return b > 0 ? 'due' : b < 0 ? 'adv' : 'settled'; }
  function balLabel(b) { b = Number(b); return b > 0 ? 'Due' : b < 0 ? 'Advance' : 'Settled'; }
  function getCustomer(id) { return state.customers.find(function (c) { return c.customer_id === id; }) || null; }
  function getProduct(id) { return state.products.find(function (p) { return p.id === id; }) || null; }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy') ? resolve() : reject(); } catch (e) { reject(e); } finally { ta.remove(); }
    });
  }

  /* ---------- CSV ---------- */
  function csvCell(v) {
    if (v == null) return '';
    if (typeof v === 'number') return String(v);
    var s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // neutralise spreadsheet formula injection
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function downloadCSV(filename, header, rows) {
    var lines = [header].concat(rows).map(function (r) { return r.map(csvCell).join(','); });
    var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1500);
  }

  /* ---------- toast / modal / confirm ---------- */
  function toast(msg, type, ms) {
    var root = $('#toast-root');
    var el = document.createElement('div');
    el.className = 'toast ' + (type || 'info');
    el.textContent = msg;
    root.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('show'); });
    setTimeout(function () { el.classList.remove('show'); setTimeout(function () { el.remove(); }, 300); }, ms || 4200);
  }

  function openModal(opts) {
    var root = $('#modal-root');
    var wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.innerHTML =
      '<div class="modal ' + (opts.size || '') + '" role="dialog" aria-modal="true" aria-label="' + esc(opts.title) + '">' +
      '<div class="modal-head"><h3>' + esc(opts.title) + '</h3><button class="icon-btn" data-close aria-label="Close">✕</button></div>' +
      '<div class="modal-body">' + opts.html + '</div></div>';
    root.appendChild(wrap);
    document.body.classList.add('modal-open');
    var closed = false;
    function onKey(e) { if (e.key === 'Escape' && root.lastElementChild === wrap) close(); }
    function close() {
      if (closed) return;
      closed = true;
      wrap.remove();
      document.removeEventListener('keydown', onKey);
      if (!root.children.length) document.body.classList.remove('modal-open');
      if (opts.onClose) opts.onClose();
    }
    document.addEventListener('keydown', onKey);
    wrap.addEventListener('mousedown', function (e) { if (e.target === wrap) close(); });
    $$('[data-close]', wrap).forEach(function (b) { b.addEventListener('click', close); });
    var body = $('.modal-body', wrap);
    if (opts.onMount) opts.onMount(body, close);
    var first = $('input:not([disabled]):not([type=hidden]):not([type=radio]),select,textarea', body);
    if (first && !/Mobi|Android/i.test(navigator.userAgent)) first.focus();
    return close;
  }

  function confirmDialog(message, okLabel, danger) {
    return new Promise(function (resolve) {
      var decided = false;
      openModal({
        title: 'Please confirm',
        html: '<p>' + esc(message) + '</p><div class="form-actions"><button class="btn ghost" data-no>Cancel</button><button class="btn ' + (danger ? 'danger' : 'primary') + '" data-yes>' + esc(okLabel || 'Confirm') + '</button></div>',
        onMount: function (b, close) {
          $('[data-no]', b).onclick = function () { decided = true; resolve(false); close(); };
          $('[data-yes]', b).onclick = function () { decided = true; resolve(true); close(); };
        },
        onClose: function () { if (!decided) resolve(false); }
      });
    });
  }

  function withBusy(btn, fn) {
    if (!btn || btn.disabled) return Promise.resolve();
    var label = btn.innerHTML;
    btn.disabled = true; btn.classList.add('busy');
    return Promise.resolve().then(fn).finally(function () {
      btn.disabled = false; btn.classList.remove('busy'); btn.innerHTML = label;
    });
  }

  function emptyHTML(icon, title, text, action) {
    return '<div class="empty"><span class="ico">' + icon + '</span><h3>' + esc(title) + '</h3><p>' + esc(text || '') + '</p>' + (action || '') + '</div>';
  }
  function loadingHTML() { return '<div class="skeleton"><i></i><i></i><i></i></div>'; }

  /* ------------------------------------------------------------------ */
  /* API helpers                                                         */
  /* ------------------------------------------------------------------ */
  function isExpired(e) {
    var m = (e && e.message) || '';
    return !!e && (e.code === 'PGRST301' || e.status === 401 || /jwt (is )?(expired|invalid)|invalid jwt|jwt expired/i.test(m));
  }
  function friendly(e) {
    var m = (e && e.message) || 'Something went wrong.';
    if (isExpired(e)) return SESSION_MSG;
    if (e.code === '23505') {
      if (/mobile/.test(m)) return 'A customer with this mobile number already exists.';
      if (/username/.test(m)) return 'This username is already taken.';
      if (/products_stall_name/.test(m)) return 'A product with this name already exists.';
      return 'This record already exists.';
    }
    if (e.code === '23514') return 'Please check the values you entered.';
    if (e.code === '42501') return /append-only/.test(m) ? m : 'You do not have permission to do that.';
    if (/failed to fetch|networkerror|load failed|network request failed/i.test(m)) return 'Network problem. Check your internet connection and try again.';
    return m;
  }
  function wrapError(e) {
    var err = new Error(friendly(e));
    err.code = e && e.code;
    err.expired = isExpired(e);
    return err;
  }
  function q(promise) {
    return Promise.resolve(promise).then(function (res) {
      if (res.error) throw wrapError(res.error);
      return res.data;
    }, function (e) { throw wrapError(e); });
  }
  function handleError(err, fallback) {
    console.error(err);
    if (err && err.expired) { forceLogout(SESSION_MSG); return; }
    toast((err && err.message) || fallback || 'Something went wrong.', 'error');
  }
  function fetchAll(build, pageSize, maxRows) {
    pageSize = pageSize || 1000; maxRows = maxRows || 20000;
    var all = [];
    function page(from) {
      return q(build().range(from, from + pageSize - 1)).then(function (rows) {
        all = all.concat(rows);
        if (rows.length < pageSize || all.length >= maxRows) return all;
        return page(from + pageSize);
      });
    }
    return page(0);
  }
  function invokeFn(name, body) {
    return sb.functions.invoke(name, { body: body }).then(function (res) {
      if (res.error) {
        var ctx = res.error.context;
        var status = ctx && ctx.status;
        var read = ctx && typeof ctx.text === 'function' ? ctx.text().catch(function () { return ''; }) : Promise.resolve('');
        return read.then(function (txt) {
          var j = null;
          try { j = JSON.parse(txt); } catch (ignore) { /* not JSON */ }
          var fromFn = j && typeof j.error === 'string' ? j.error : '';   // our own function answered
          var platform = j && typeof j.message === 'string' ? j.message : (txt || '').slice(0, 200);
          var msg;
          if (fromFn) msg = fromFn;
          else if (!status) msg = 'Could not reach the "' + name + '" function. Check your internet, that the function is deployed with exactly this name, and the Supabase URL in supabase.js.';
          else if (status === 404) msg = 'The "' + name + '" function is not deployed in this Supabase project (404). See README step 5.';
          else if (status === 401) msg = 'Supabase rejected the login token before the function ran (401' + (platform ? ': ' + platform : '') + '). In Dashboard → Edge Functions → ' + name + ', turn OFF "Verify JWT" (the function checks the owner itself) and redeploy.';
          else msg = 'The "' + name + '" function failed (HTTP ' + status + (platform ? ': ' + platform : '') + '). Open Dashboard → Edge Functions → ' + name + ' → Logs for details.';
          console.error('Edge Function error', name, status, txt, res.error);
          var e = new Error(msg);
          e.expired = status === 401 && !!fromFn;   // only a real "session expired" answer from our function logs the user out
          throw e;
        });
      }
      if (res.data && res.data.error) throw new Error(res.data.error);
      return res.data;
    });
  }

  function loadCustomers() {
    return fetchAll(function () { return sb.from('customer_balances').select('*').order('full_name').order('customer_id'); })
      .then(function (rows) { state.customers = rows; return rows; });
  }
  function loadProducts() {
    return fetchAll(function () { return sb.from('products').select('*').order('name').order('id'); })
      .then(function (rows) { state.products = rows; return rows; });
  }

  /* ------------------------------------------------------------------ */
  /* Transaction display helpers                                         */
  /* ------------------------------------------------------------------ */
  var KIND_LABEL = { purchase: 'Purchase', payment: 'Payment', debit_adjustment: 'Debit adjustment', credit_adjustment: 'Credit adjustment' };
  function txLabel(t) {
    if (t.kind === 'reversal') return 'Reversal of ' + (KIND_LABEL[t.ledger_kind] || 'entry').toLowerCase();
    return KIND_LABEL[t.kind] || t.kind;
  }
  function itemsSummary(t) {
    return (t.transaction_items || []).map(function (i) { return i.product_name + ' ×' + num(i.quantity); }).join(', ');
  }
  function txDetails(t) {
    if (t.kind === 'purchase') return itemsSummary(t);
    if (t.ledger_kind === 'payment') return 'via ' + (t.payment_method || '—');
    return '';
  }
  function buildLedger(rowsAsc) {
    var run = 0;
    return rowsAsc.map(function (t) { run = round2(run + Number(t.balance_effect)); return Object.assign({}, t, { running: run }); });
  }

  function ledgerCardHTML(t, owner) {
    var eff = Number(t.balance_effect);
    var side = eff > 0 ? 'debit' : 'credit';
    var items = t.transaction_items || [];
    var body = '';
    if (items.length) {
      body = '<div class="l-body"><table class="mini"><thead><tr><th>Item</th><th>Qty</th><th>Unit price</th><th>Total</th></tr></thead><tbody>' +
        items.map(function (i) {
          return '<tr><td>' + esc(i.product_name) + '</td><td>' + num(i.quantity) + '</td><td>' + money(i.unit_price) + '</td><td>' + money(i.line_total) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    } else if (t.ledger_kind === 'payment') {
      body = '<div class="l-body"><span class="badge ' + (t.kind === 'reversal' ? 'gray' : 'green') + '">' + esc(t.payment_method || '') + '</span></div>';
    }
    var tags = '';
    if (t.is_reversed) tags += '<span class="badge gray">Reversed</span>';
    if (t.kind === 'reversal') tags += '<span class="badge orange">Correction</span>';
    var action = (owner && t.kind !== 'reversal' && !t.is_reversed)
      ? '<button class="btn sm ghost" data-reverse="' + esc(t.id) + '">Reverse</button>' : '';
    return '<article class="l-item ' + side + (t.is_reversed ? ' reversed' : '') + '">' +
      '<div class="l-head"><div><div class="l-title">' + esc(txLabel(t)) + ' ' + tags + '</div>' +
      '<div class="l-when">' + fmtDate(t.created_at) + ' · ' + fmtTime(t.created_at) + '</div></div>' +
      '<div class="l-amt ' + side + '">' + (eff > 0 ? '+' : '−') + money(Math.abs(eff)) + '</div></div>' +
      body +
      (t.note ? '<div class="l-note">“' + esc(t.note) + '”</div>' : '') +
      '<div class="l-foot"><span>Balance after: <b class="' + balClass(t.running) + '">' + money(t.running) + '</b></span>' + action + '</div></article>';
  }

  /* shared ledger panel: filters, summary, list, CSV */
  function renderLedgerPanel(host, rowsAsc, opts) {
    var rows = buildLedger(rowsAsc);
    var shown = 100;
    host.innerHTML =
      '<div class="toolbar">' +
      '<label class="field-inline">From <input type="date" id="lfFrom" class="input"></label>' +
      '<label class="field-inline">To <input type="date" id="lfTo" class="input"></label>' +
      '<select id="lfSort" class="input" aria-label="Sort order"><option value="desc">Newest first</option><option value="asc">Oldest first</option></select>' +
      '<button class="btn sm ghost" id="lfClear">Clear</button>' +
      '<button class="btn sm" id="lfCsv">⬇ Export CSV</button></div>' +
      '<div id="lfSummary"></div><div id="lfList" class="ledger"></div><div id="lfMore" class="form-actions" style="justify-content:center"></div>';

    function filtered() {
      var from = $('#lfFrom', host).value, to = $('#lfTo', host).value;
      return rows.filter(function (t) { return (!from || t.txn_date >= from) && (!to || t.txn_date <= to); });
    }
    function draw() {
      var list = filtered();
      var purchases = 0, payments = 0;
      list.forEach(function (t) {
        var e = Number(t.balance_effect);
        if (t.ledger_side === 'debit') purchases += e; else payments -= e;
      });
      var closing = list.length ? list[list.length - 1].running : 0;
      $('#lfSummary', host).innerHTML =
        '<div class="stats three"><div class="stat"><div class="label">Purchases</div><div class="value">' + money(purchases) + '</div></div>' +
        '<div class="stat"><div class="label">Payments</div><div class="value">' + money(payments) + '</div></div>' +
        '<div class="stat accent"><div class="label">Balance after period</div><div class="value">' + money(closing) + '</div></div></div>';
      var ordered = $('#lfSort', host).value === 'desc' ? list.slice().reverse() : list;
      var el = $('#lfList', host);
      if (!ordered.length) {
        el.innerHTML = emptyHTML('📒', 'No transactions', rows.length ? 'Nothing matches these dates.' : 'Entries will appear here as soon as they are recorded.');
        $('#lfMore', host).innerHTML = '';
        return;
      }
      el.innerHTML = ordered.slice(0, shown).map(function (t) { return ledgerCardHTML(t, opts.owner); }).join('');
      $('#lfMore', host).innerHTML = ordered.length > shown ? '<button class="btn" id="lfShowMore">Show more (' + (ordered.length - shown) + ' left)</button>' : '';
      var more = $('#lfShowMore', host);
      if (more) more.onclick = function () { shown += 100; draw(); };
    }
    ['#lfFrom', '#lfTo', '#lfSort'].forEach(function (s) { $(s, host).addEventListener('change', function () { shown = 100; draw(); }); });
    $('#lfClear', host).onclick = function () { $('#lfFrom', host).value = ''; $('#lfTo', host).value = ''; shown = 100; draw(); };
    $('#lfCsv', host).onclick = function () {
      var list = filtered();
      if (!list.length) return toast('Nothing to export for these dates.', 'error');
      downloadCSV((opts.csvName || 'ledger') + '-' + todayISO() + '.csv',
        ['Date', 'Time', 'Type', 'Items', 'Payment method', 'Charge (Rs)', 'Credit (Rs)', 'Balance after (Rs)', 'Note'],
        list.map(function (t) {
          var e = Number(t.balance_effect);
          return [fmtISODate(t.txn_date), fmtTime(t.created_at), txLabel(t) + (t.is_reversed ? ' (reversed)' : ''),
            (t.transaction_items || []).map(function (i) { return i.product_name + ' x' + num(i.quantity) + ' @ ' + Number(i.unit_price).toFixed(2); }).join('; '),
            t.payment_method || '', e > 0 ? e : '', e < 0 ? -e : '', t.running, t.note || ''];
        }));
    };
    host.addEventListener('click', function (e) {
      var b = e.target.closest('[data-reverse]');
      if (!b || !opts.onReverse) return;
      var t = rows.find(function (x) { return x.id === b.dataset.reverse; });
      if (t) opts.onReverse(t);
    });
    draw();
  }

  function openReverseModal(t, done) {
    var summary = txLabel(t) + ' of ' + money(t.amount) + ' on ' + fmtDate(t.created_at);
    var rid = uuid();
    openModal({
      title: 'Reverse transaction',
      html: '<p>' + esc(summary) + '</p><p class="hint">The original entry stays in the ledger. A reversal entry is added so the balance is corrected.</p>' +
        '<form id="revForm"><div class="field"><label for="revReason">Reason (required)</label><input id="revReason" type="text" maxlength="300" placeholder="e.g. Wrong customer selected" required></div>' +
        '<div class="error-text" id="revErr"></div>' +
        '<div class="form-actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn danger" type="submit">Reverse entry</button></div></form>',
      onMount: function (b, close) {
        $('#revForm', b).onsubmit = function (ev) {
          ev.preventDefault();
          var reason = $('#revReason', b).value.trim();
          if (reason.length < 3) { $('#revErr', b).textContent = 'Please enter a reason (at least 3 characters).'; return; }
          withBusy($('button[type=submit]', b), function () {
            return q(sb.rpc('reverse_transaction', { p_tx: t.id, p_reason: reason, p_request_id: rid })).then(function () {
              toast('Transaction reversed.', 'success'); close(); if (done) done();
            }).catch(function (err) { $('#revErr', b).textContent = err.message; if (err.expired) handleError(err); });
          });
        };
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* Auth screens                                                        */
  /* ------------------------------------------------------------------ */
  function hideBoot() { var b = $('#boot'); if (b) { b.classList.add('done'); setTimeout(function () { b.remove(); }, 400); } }

  function showConfigError(msg) {
    hideBoot();
    $('#app').innerHTML = '<div class="config-error"><h2>☕ Chai Khata needs setup</h2><p>' + esc(msg) + '</p>' +
      '<p>Open <code>supabase.js</code> and paste your Supabase <b>Project URL</b> and <b>publishable (anon) key</b>. The README has step-by-step instructions.</p></div>';
  }

  function authShell(inner, message, kind) {
    $('#app').innerHTML = '<div class="auth-wrap"><div class="auth-card">' +
      '<div class="auth-brand"><div class="logo">☕</div><h1>Chai Khata</h1><p>Your digital tea-stall ledger</p></div>' +
      (message ? '<div class="auth-alert ' + (kind || 'info') + '" role="alert">' + esc(message) + '</div>' : '') + inner + '</div></div>';
    hideBoot();
  }

  function pwField(id, label, autocomplete) {
    return '<div class="field"><label for="' + id + '">' + label + '</label><div class="pw-wrap">' +
      '<input id="' + id + '" type="password" autocomplete="' + autocomplete + '" required><button type="button" class="pw-toggle" data-toggle="' + id + '">Show</button></div></div>';
  }
  function bindPwToggles(root) {
    $$('[data-toggle]', root).forEach(function (b) {
      b.onclick = function () {
        var i = $('#' + b.dataset.toggle, root);
        i.type = i.type === 'password' ? 'text' : 'password';
        b.textContent = i.type === 'password' ? 'Show' : 'Hide';
      };
    });
  }

  function renderLogin(message, kind) {
    authShell(
      '<form id="loginForm" novalidate>' +
      '<div class="field"><label for="loginId">Mobile number, username or owner email</label>' +
      '<input id="loginId" type="text" inputmode="email" autocomplete="username" autocapitalize="none" spellcheck="false" required></div>' +
      pwField('loginPw', 'Password', 'current-password') +
      '<div class="error-text" id="loginErr" role="alert"></div>' +
      '<button class="btn primary block" type="submit">Sign in</button>' +
      '<div class="auth-links"><button type="button" class="link-btn" id="forgotLink">Forgot password?</button></div></form>',
      message, kind);
    var root = $('#app');
    bindPwToggles(root);
    $('#forgotLink').onclick = renderForgot;
    $('#loginForm').onsubmit = function (e) {
      e.preventDefault();
      var id = $('#loginId').value.trim(), pw = $('#loginPw').value, err = $('#loginErr');
      err.textContent = '';
      if (Date.now() < state.lockUntil) { err.textContent = 'Too many attempts. Please wait ' + Math.ceil((state.lockUntil - Date.now()) / 1000) + ' seconds.'; return; }
      if (!id || !pw) { err.textContent = 'Enter your login and password.'; return; }
      withBusy($('button[type=submit]', root), function () {
        return q(sb.rpc('resolve_login', { p_identifier: id })).then(function (email) {
          return sb.auth.signInWithPassword({ email: email, password: pw });
        }).then(function (res) {
          if (res.error) {
            if (/fetch|network/i.test(res.error.message)) throw new Error('Network problem. Check your internet connection and try again.');
            state.loginFails++;
            if (state.loginFails >= 5) { state.lockUntil = Date.now() + 30000; state.loginFails = 0; }
            throw new Error('Incorrect login or password.');
          }
          state.loginFails = 0;
          return startApp();
        }).catch(function (e2) { err.textContent = e2.message; });
      });
    };
  }

  function renderForgot() {
    authShell(
      '<form id="forgotForm" novalidate><p class="hint">Stall owners: enter your email and we will send a reset link.<br>Customers: please ask the stall owner to reset your password.</p>' +
      '<div class="field"><label for="fgEmail">Owner email</label><input id="fgEmail" type="email" autocomplete="email" required></div>' +
      '<div class="error-text" id="fgErr"></div>' +
      '<button class="btn primary block" type="submit">Send reset link</button>' +
      '<div class="auth-links"><button type="button" class="link-btn" id="backLogin">← Back to sign in</button></div></form>');
    $('#backLogin').onclick = function () { renderLogin(); };
    $('#forgotForm').onsubmit = function (e) {
      e.preventDefault();
      var email = $('#fgEmail').value.trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { $('#fgErr').textContent = 'Enter a valid email address.'; return; }
      withBusy($('button[type=submit]', $('#app')), function () {
        return sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname }).then(function () {
          renderLogin('If that email belongs to an owner account, a reset link is on its way. Check your inbox.', 'success');
        });
      });
    };
  }

  function validatePassword(pw, ctx) {
    if (pw.length < 8) return 'Use at least 8 characters.';
    if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'Use both letters and numbers.';
    if (ctx.mobile && pw.indexOf(ctx.mobile) !== -1) return 'Your password should not contain your mobile number.';
    if (ctx.current && pw === ctx.current) return 'The new password must be different from the current one.';
    return '';
  }

  function passwordFormHTML(opts) {
    return '<form id="pwForm" novalidate>' +
      (opts.recovery ? '' : pwField('pwCurrent', 'Current password', 'current-password')) +
      pwField('pwNew', 'New password', 'new-password') +
      pwField('pwConfirm', 'Confirm new password', 'new-password') +
      '<p class="hint">At least 8 characters with letters and numbers.</p>' +
      '<div class="error-text" id="pwErr" role="alert"></div>' +
      '<button class="btn primary block" type="submit">Update password</button></form>';
  }
  function bindPasswordForm(root, opts) {
    bindPwToggles(root);
    $('#pwForm', root).onsubmit = function (e) {
      e.preventDefault();
      var err = $('#pwErr', root); err.textContent = '';
      var cur = opts.recovery ? '' : $('#pwCurrent', root).value;
      var nw = $('#pwNew', root).value, cf = $('#pwConfirm', root).value;
      if (!opts.recovery && !cur) { err.textContent = 'Enter your current password.'; return; }
      var v = validatePassword(nw, { mobile: state.profile && state.profile.mobile, current: cur });
      if (v) { err.textContent = v; return; }
      if (nw !== cf) { err.textContent = 'The two new passwords do not match.'; return; }
      withBusy($('button[type=submit]', root), function () {
        var step = opts.recovery ? Promise.resolve() :
          sb.auth.signInWithPassword({ email: state.profile.login_email, password: cur }).then(function (r) {
            if (r.error) throw new Error('Your current password is incorrect.');
          });
        return step.then(function () { return sb.auth.updateUser({ password: nw }); }).then(function (r) {
          if (r.error) {
            if (isExpired(r.error)) throw wrapError(r.error);
            throw new Error(/same|different/i.test(r.error.message) ? 'The new password must be different from the current one.' : r.error.message);
          }
          return state.profile ? q(sb.rpc('mark_password_changed')) : null;
        }).then(function () { return opts.onDone(); })
          .catch(function (e2) { if (e2.expired) handleError(e2); else err.textContent = e2.message; });
      });
    };
  }

  function renderForcedChange() {
    authShell('<h2 style="font-size:20px;margin-bottom:6px">Set your own password</h2>' +
      '<p class="hint">Welcome, ' + esc(state.profile.full_name) + '! For your safety, please replace the initial password before continuing.</p>' +
      passwordFormHTML({ recovery: false }) +
      '<div class="auth-links"><button type="button" class="link-btn" id="forcedOut">Sign out</button></div>');
    bindPasswordForm($('#app'), {
      recovery: false,
      onDone: function () { state.profile.must_change_password = false; toast('Password updated. Welcome!', 'success'); renderShell(); route(); }
    });
    $('#forcedOut').onclick = signOut;
  }

  function renderRecovery() {
    authShell('<h2 style="font-size:20px;margin-bottom:6px">Choose a new password</h2>' + passwordFormHTML({ recovery: true }) +
      '<div class="auth-links"><button type="button" class="link-btn" id="recOut">Cancel</button></div>');
    bindPasswordForm($('#app'), {
      recovery: true,
      onDone: function () { state.recovery = false; toast('Password updated.', 'success'); return startApp(); }
    });
    $('#recOut').onclick = function () { state.recovery = false; signOut(); };
  }

  /* ------------------------------------------------------------------ */
  /* Session lifecycle                                                   */
  /* ------------------------------------------------------------------ */
  /* ---------- customer notifications (bell, feed, live alerts) ---------- */
  var notif = { items: [], channel: null, timer: null, known: null };

  function localSeenKey() { return 'ck_seen_' + (state.profile ? state.profile.id : ''); }
  function getSeenAt() {
    var a = state.profile && state.profile.notifications_seen_at ? new Date(state.profile.notifications_seen_at).getTime() : 0;
    var b = 0;
    try { b = Number(localStorage.getItem(localSeenKey())) || 0; } catch (e) { /* storage unavailable */ }
    return Math.max(a, b);
  }
  function notifUnread() {
    var s = getSeenAt();
    return notif.items.filter(function (t) { return new Date(t.created_at).getTime() > s; });
  }
  function notifIcon(t) {
    if (t.kind === 'purchase') return '🧾';
    if (t.kind === 'payment') return '💰';
    if (t.kind === 'reversal') return '↩️';
    return '✏️';
  }
  function notifText(t) {
    var amt = money(t.amount);
    if (t.kind === 'purchase') { var s = itemsSummary(t); return 'Purchase of ' + amt + ' added' + (s ? ': ' + s : ''); }
    if (t.kind === 'payment') return 'Payment of ' + amt + ' received' + (t.payment_method ? ' via ' + t.payment_method : '');
    if (t.kind === 'debit_adjustment') return 'Charge adjustment of ' + amt + ' added to your account';
    if (t.kind === 'credit_adjustment') return 'Credit adjustment of ' + amt + ' applied to your account';
    if (t.kind === 'reversal') {
      var what = t.ledger_kind === 'purchase' ? 'Purchase' : t.ledger_kind === 'payment' ? 'Payment' : 'Adjustment';
      return what + ' of ' + amt + ' was reversed by the stall';
    }
    return txLabel(t);
  }
  function updateBell() {
    var b = $('#bellBadge'); if (!b) return;
    var n = notifUnread().length;
    b.textContent = n > 9 ? '9+' : String(n);
    b.classList.toggle('hidden', n === 0);
  }
  function loadNotifications() {
    return q(sb.from('transactions').select('*, transaction_items(id,product_name,quantity,unit_price,line_total)')
      .eq('customer_id', state.profile.id).order('created_at', { ascending: false }).limit(30)).then(function (rows) {
      notif.items = rows; updateBell(); return rows;
    });
  }
  // Reload the feed; when `announce` is true, pop a toast for entries we have not seen arrive before.
  function refreshNotifications(announce) {
    if (!state.profile || isOwner()) return Promise.resolve();
    var prev = notif.known;
    return loadNotifications().then(function (rows) {
      var ids = {};
      rows.forEach(function (t) { ids[t.id] = 1; });
      if (announce && prev) {
        var fresh = rows.filter(function (t) { return !prev[t.id]; });
        if (fresh.length) {
          toast('🔔 ' + notifText(fresh[0]) + ' · ' + fmtDate(fresh[0].created_at) + ', ' + fmtTime(fresh[0].created_at), 'info', 9000);
          var name = currentRoute().name;
          if ((name === 'home' || name === 'ledger') && !$('#modal-root').children.length) route();
        }
      }
      notif.known = ids;
    }).catch(function (err) { if (err && err.expired) handleError(err); });
  }
  function stopNotifications() {
    if (notif.timer) clearInterval(notif.timer);
    if (notif.channel && window.sb) { try { sb.removeChannel(notif.channel); } catch (e) { /* ignore */ } }
    notif.items = []; notif.channel = null; notif.timer = null; notif.known = null;
  }
  function startNotifications() {
    stopNotifications();
    if (!state.profile || isOwner()) return;
    var uid = state.profile.id;
    refreshNotifications(false);
    try {
      // Live push (needs the Realtime step in supabase-setup.sql); RLS limits events to this customer's own rows.
      notif.channel = sb.channel('khata-' + uid)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'transactions', filter: 'customer_id=eq.' + uid },
          function () { setTimeout(function () { refreshNotifications(true); }, 500); })
        .subscribe();
    } catch (e) { console.warn('Realtime unavailable, falling back to polling.', e); }
    notif.timer = setInterval(function () { refreshNotifications(true); }, 60000); // safety net if Realtime is off
  }
  function markNotificationsSeen() {
    return Promise.resolve(sb.rpc('mark_notifications_seen')).then(function (res) {
      if (res.error) throw res.error;
      if (state.profile) state.profile.notifications_seen_at = res.data;
      try { localStorage.removeItem(localSeenKey()); } catch (e) { /* ignore */ }
    }).catch(function () {
      try { localStorage.setItem(localSeenKey(), String(Date.now())); } catch (e) { /* ignore */ }
    }).then(updateBell);
  }
  function openNotifications() {
    var seen = getSeenAt();
    var list = notif.items.length ? '<div class="ledger">' + notif.items.map(function (t) {
      var isNew = new Date(t.created_at).getTime() > seen;
      return '<article class="l-item notif' + (isNew ? ' unread' : '') + '"><div class="l-title">' + notifIcon(t) + ' ' + esc(notifText(t)) + (isNew ? ' <span class="badge orange">New</span>' : '') + '</div>' +
        '<div class="l-when">' + fmtDate(t.created_at) + ' · ' + fmtTime(t.created_at) + '</div>' +
        (t.note ? '<div class="l-note">“' + esc(t.note) + '”</div>' : '') + '</article>';
    }).join('') + '</div>' : emptyHTML('🔔', 'No updates yet', 'You will be notified here whenever the stall adds a purchase or payment to your khata.');
    openModal({
      title: 'Notifications', size: 'lg',
      html: list + '<div class="form-actions"><a class="btn primary" href="#/ledger" data-close>Open my ledger</a></div>'
    });
    markNotificationsSeen();
  }
  function notifBannerHTML() {
    var un = notifUnread(); if (!un.length) return '';
    return '<button type="button" class="notif-banner" id="notifBanner"><span class="ico">🔔</span><span><b>' + un.length + ' new update' + (un.length > 1 ? 's' : '') + ' from the stall</b><br>' +
      esc(notifText(un[0])) + '<br><small>' + fmtDate(un[0].created_at) + ' · ' + fmtTime(un[0].created_at) + '</small></span></button>';
  }

  function resetState() {
    stopNotifications();
    state.profile = null; state.stall = null; state.customers = []; state.products = [];
    entry.customerId = null; entry.cart.clear(); entry.note = ''; entry.sigs = {}; entry.ids = {};
    state.renderToken++;
  }
  function forceLogout(msg) {
    var had = !!state.profile;
    resetState();
    sb.auth.signOut({ scope: 'local' }).catch(function () {}).finally(function () {
      renderLogin(had || msg ? (msg || SESSION_MSG) : undefined, 'error');
    });
  }
  function signOut() {
    resetState();
    sb.auth.signOut().catch(function () {}).finally(function () { location.hash = ''; renderLogin('You have been signed out.', 'info'); });
  }

  function startApp() {
    return sb.auth.getSession().then(function (r) {
      var session = r.data && r.data.session;
      if (!session) { renderLogin(); return; }
      return q(sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle()).then(function (profile) {
        if (!profile) { forceLogout('This account is not set up for Chai Khata. Please contact the stall owner.'); return; }
        if (!profile.is_active) { forceLogout('This account has been deactivated. Please contact the stall owner.'); return; }
        state.profile = profile;
        return q(sb.from('stalls').select('*').maybeSingle()).then(function (stall) {
          state.stall = stall || { name: 'Chai Khata' };
          if (profile.must_change_password) { renderForcedChange(); return; }
          renderShell();
          if (!currentRoute().name) location.hash = '#/' + (isOwner() ? 'dashboard' : 'home');
          else route();
        });
      });
    }).catch(function (err) {
      if (err.expired) { forceLogout(SESSION_MSG); return; }
      console.error(err);
      authShell('<div class="error-box">' + esc(err.message || 'Could not load your account.') + '<br><button class="btn" id="retryBoot">Try again</button></div>');
      $('#retryBoot').onclick = startApp;
    });
  }

  /* ------------------------------------------------------------------ */
  /* Shell & router                                                      */
  /* ------------------------------------------------------------------ */
  function renderShell() {
    var owner = isOwner();
    var nav = owner ? OWNER_NAV : CUSTOMER_NAV;
    var bottom = nav.filter(function (n) { return n.bottom; });
    var hasMore = owner;
    $('#app').innerHTML =
      '<div class="shell ' + (owner ? 'owner' : 'customer') + '">' +
      '<aside class="sidebar"><div class="brand">☕ <span>Chai Khata</span></div><div class="stall-name">' + esc(state.stall.name) + '</div>' +
      '<nav>' + nav.map(function (n) { return '<a href="#/' + n.id + '" class="nav-link" data-nav="' + n.id + '"><span class="ico">' + n.icon + '</span>' + n.label + '</a>'; }).join('') + '</nav>' +
      '<div class="side-foot"><div class="who">' + esc(state.profile.full_name) + '<small>' + (owner ? 'Owner' : 'Customer') + '</small></div>' +
      '<button class="btn ghost light" id="logoutSide">Sign out</button></div></aside>' +
      '<div class="main"><header class="topbar"><div class="brand-sm">☕ Chai Khata</div><h1 id="pageTitle"></h1>' +
      (owner ? '' : '<button class="icon-btn bell" id="bellBtn" title="Notifications" aria-label="Notifications">🔔<span class="bell-badge hidden" id="bellBadge">0</span></button>') +
      '<button class="icon-btn" id="logoutTop" title="Sign out" aria-label="Sign out">⎋</button></header>' +
      '<main id="view" class="view" tabindex="-1"></main></div>' +
      '<nav class="bottom-nav" aria-label="Main">' +
      bottom.map(function (n) { return '<a href="#/' + n.id + '" data-nav="' + n.id + '"><span class="ico">' + n.icon + '</span>' + n.label + '</a>'; }).join('') +
      (hasMore ? '<button id="moreBtn"><span class="ico">⋯</span>More</button>' : '') + '</nav></div>';
    $('#logoutSide').onclick = signOut;
    $('#logoutTop').onclick = signOut;
    if (!owner) { $('#bellBtn').onclick = openNotifications; updateBell(); startNotifications(); }
    var more = $('#moreBtn');
    if (more) more.onclick = function () {
      var rest = OWNER_NAV.filter(function (n) { return !n.bottom; });
      openModal({
        title: 'More',
        html: '<div class="ledger">' + rest.map(function (n) { return '<a class="btn block" href="#/' + n.id + '" data-close>' + n.icon + ' ' + n.label + '</a>'; }).join('') +
          '<button class="btn block danger" id="moreOut">Sign out</button></div>',
        onMount: function (b, close) { $('#moreOut', b).onclick = function () { close(); signOut(); }; }
      });
    };
  }

  function currentRoute() {
    var m = location.hash.match(/^#\/([a-z]+)(?:\/([0-9a-f-]{36}))?/i);
    return m ? { name: m[1].toLowerCase(), id: m[2] || null } : { name: null, id: null };
  }

  var OWNER_VIEWS = {
    dashboard: { title: 'Dashboard', render: viewDashboard },
    entry: { title: 'New Entry', render: viewEntry },
    customers: { title: 'Customers', render: viewCustomers },
    transactions: { title: 'Transactions', render: viewTransactions },
    products: { title: 'Products', render: viewProducts },
    reports: { title: 'Reports', render: viewReports },
    settings: { title: 'Settings', render: viewSettings }
  };
  var CUSTOMER_VIEWS = {
    home: { title: 'My Khata', render: viewHome },
    ledger: { title: 'My Ledger', render: viewMyLedger },
    profile: { title: 'My Profile', render: viewProfile }
  };

  function route() {
    if (!state.profile || state.profile.must_change_password || !$('#view')) return;
    var views = isOwner() ? OWNER_VIEWS : CUSTOMER_VIEWS;
    var r = currentRoute();
    if (!r.name || !views[r.name]) { location.replace('#/' + (isOwner() ? 'dashboard' : 'home')); return; }
    var active = r.name;
    $$('[data-nav]').forEach(function (a) { a.classList.toggle('active', a.dataset.nav === active); if (a.dataset.nav === active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    var v = views[r.name];
    $('#pageTitle').textContent = r.name === 'customers' && r.id ? 'Customer Ledger' : v.title;
    document.title = v.title + ' · Chai Khata';
    var token = ++state.renderToken;
    var alive = function () { return token === state.renderToken; };
    var el = $('#view');
    el.innerHTML = loadingHTML();
    Promise.resolve().then(function () { return v.render(el, r, alive); }).catch(function (err) {
      if (!alive()) return;
      if (err && err.expired) { handleError(err); return; }
      console.error(err);
      el.innerHTML = '<div class="error-box"><strong>Could not load this page.</strong><br>' + esc(err.message || '') + '<br><button class="btn" id="retryView">Try again</button></div>';
      var rb = $('#retryView'); if (rb) rb.onclick = route;
    });
    window.scrollTo(0, 0);
  }

  /* ------------------------------------------------------------------ */
  /* OWNER: Dashboard                                                    */
  /* ------------------------------------------------------------------ */
  function viewDashboard(el, r, alive) {
    var today = todayISO();
    return Promise.all([
      loadCustomers(),
      q(sb.rpc('report_daily', { p_from: today, p_to: today })),
      q(sb.from('transactions').select(TX_SELECT).order('created_at', { ascending: false }).limit(8))
    ]).then(function (res) {
      if (!alive()) return;
      var customers = res[0], t = res[1][0] || { sales: 0, collections: 0, bills: 0 }, recent = res[2];
      var dues = customers.filter(function (c) { return Number(c.balance) > 0; }).sort(function (a, b) { return b.balance - a.balance; });
      var outstanding = dues.reduce(function (s, c) { return s + Number(c.balance); }, 0);
      el.innerHTML =
        '<div class="stats">' +
        '<div class="stat accent"><div class="label">Today’s sales</div><div class="value">' + money(t.sales) + '</div><div class="sub">' + (t.bills || 0) + ' bill(s)</div></div>' +
        '<div class="stat"><div class="label">Collected today</div><div class="value">' + money(t.collections) + '</div></div>' +
        '<div class="stat"><div class="label">Total outstanding</div><div class="value">' + money(outstanding) + '</div><div class="sub">' + dues.length + ' customer(s) with dues</div></div>' +
        '<div class="stat"><div class="label">Customers</div><div class="value">' + customers.length + '</div><div class="sub">' + customers.filter(function (c) { return c.is_active; }).length + ' active</div></div></div>' +
        '<div class="toolbar"><a class="btn primary" href="#/entry">➕ New entry</a><a class="btn" href="#/customers">👥 Customers</a><a class="btn" href="#/reports">📊 Reports</a></div>' +
        '<div class="two-col"><section class="card"><h2 class="card-title">Recent activity <a class="btn sm ghost" href="#/transactions">View all</a></h2>' +
        (recent.length ? '<div class="table-wrap"><table class="table stack"><thead><tr><th>When</th><th>Customer</th><th>Type</th><th class="num">Amount</th></tr></thead><tbody>' +
          recent.map(function (x) {
            var e = Number(x.balance_effect);
            return '<tr class="' + (x.is_reversed ? 'reversed' : '') + '"><td data-label="When">' + fmtDate(x.created_at) + ' ' + fmtTime(x.created_at) + '</td><td data-label="Customer">' + esc(x.customer ? x.customer.full_name : '') + '</td><td data-label="Type">' + esc(txLabel(x)) + '</td><td data-label="Amount" class="num"><span class="amt ' + (e > 0 ? 'debit' : 'credit') + '">' + money(Math.abs(e)) + '</span></td></tr>';
          }).join('') + '</tbody></table></div>' : emptyHTML('🧾', 'No transactions yet', 'Record your first purchase to get started.', '<a class="btn primary" href="#/entry">New entry</a>')) +
        '</section><section class="card"><h2 class="card-title">Top dues</h2>' +
        (dues.length ? '<div class="ledger">' + dues.slice(0, 6).map(function (c) {
          return '<a class="l-item" style="text-decoration:none;color:inherit" href="#/customers/' + c.customer_id + '"><div class="l-head"><div><div class="l-title">' + esc(c.full_name) + '</div><div class="l-when">' + esc(c.mobile) + '</div></div><div class="l-amt debit">' + money(c.balance) + '</div></div></a>';
        }).join('') + '</div>' : emptyHTML('🎉', 'No dues', 'All customers are settled up.')) + '</section></div>';
    });
  }

  /* ------------------------------------------------------------------ */
  /* OWNER: New entry (purchase / payment / adjustment)                  */
  /* ------------------------------------------------------------------ */
  function requestIdFor(kind, sig) {
    if (entry.sigs[kind] !== sig || !entry.ids[kind]) { entry.sigs[kind] = sig; entry.ids[kind] = uuid(); }
    return entry.ids[kind];
  }
  function clearRequest(kind) { entry.sigs[kind] = null; entry.ids[kind] = null; }

  function viewEntry(el, r, alive) {
    return Promise.all([loadCustomers(), loadProducts()]).then(function () {
      if (!alive()) return;
      if (r.id && getCustomer(r.id)) entry.customerId = r.id;
      if (entry.customerId && !getCustomer(entry.customerId)) entry.customerId = null;
      el.innerHTML = '<div class="entry-grid"><section class="card"><h2 class="card-title">1 · Customer</h2><div id="pickerBox"></div></section>' +
        '<section class="card"><h2 class="card-title">2 · Entry</h2><div class="tabs" role="tablist">' +
        '<button data-tab="purchase">Purchase</button><button data-tab="payment">Payment</button><button data-tab="adjustment">Adjustment</button></div><div id="entryBody"></div></section></div>';
      $$('[data-tab]', el).forEach(function (b) { b.onclick = function () { entry.tab = b.dataset.tab; renderEntryBody(); }; });
      renderPicker(); renderEntryBody();
    });
  }

  function renderPicker() {
    var box = $('#pickerBox'); if (!box) return;
    var c = getCustomer(entry.customerId);
    if (c) {
      box.innerHTML = '<div class="picked"><div><strong>' + esc(c.full_name) + '</strong><div class="muted">' + esc(c.mobile) + '</div></div>' +
        '<div class="picked-bal ' + balClass(c.balance) + '">' + money(Math.abs(c.balance)) + '<small>' + balLabel(c.balance) + '</small></div></div>' +
        '<div class="toolbar" style="margin:12px 0 0"><button class="btn sm" id="changeCust">Change customer</button><a class="btn sm ghost" href="#/customers/' + c.customer_id + '">View ledger</a></div>';
      $('#changeCust').onclick = function () { entry.customerId = null; entry.cart.clear(); renderPicker(); renderEntryBody(); };
      return;
    }
    box.innerHTML = '<input type="search" id="custSearch" class="input" placeholder="Search name or mobile…" autocomplete="off" aria-label="Search customers"><ul id="custResults" class="results"></ul>';
    var input = $('#custSearch'), list = $('#custResults');
    function draw() {
      var term = input.value.trim().toLowerCase();
      var rows = state.customers.filter(function (c) {
        return c.is_active && (!term || [c.full_name, c.mobile, c.username].some(function (v) { return (v || '').toLowerCase().indexOf(term) !== -1; }));
      }).slice(0, 40);
      list.innerHTML = rows.length ? rows.map(function (c) {
        return '<li><button type="button" data-id="' + c.customer_id + '"><span>' + esc(c.full_name) + '<small class="muted">' + esc(c.mobile) + '</small></span><span class="' + balClass(c.balance) + '">' + money(c.balance) + '</span></button></li>';
      }).join('') : '<li class="muted pad">No matching active customers. <a href="#/customers">Add a customer</a></li>';
    }
    input.addEventListener('input', draw);
    list.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-id]'); if (!b) return;
      entry.customerId = b.dataset.id; renderPicker(); renderEntryBody();
    });
    draw();
  }

  function renderEntryBody() {
    var body = $('#entryBody'); if (!body) return;
    $$('[data-tab]').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === entry.tab); });
    var c = getCustomer(entry.customerId);
    if (!c) { body.innerHTML = emptyHTML('👈', 'Pick a customer first', 'Search by name or mobile number to begin.'); return; }
    if (entry.tab === 'purchase') renderPurchaseForm(body);
    else if (entry.tab === 'payment') renderPaymentForm(body, c);
    else renderAdjustmentForm(body, c);
  }

  function refreshAfterEntry() {
    return loadCustomers().then(function () { renderPicker(); renderEntryBody(); });
  }

  function renderPurchaseForm(body) {
    var prods = state.products.filter(function (p) { return p.is_active; });
    if (!prods.length) { body.innerHTML = emptyHTML('☕', 'No products yet', 'Add tea, snacks and more before recording purchases.', '<a class="btn primary" href="#/products">Add products</a>'); return; }
    body.innerHTML = '<div class="product-grid">' + prods.map(function (p) {
      return '<button type="button" class="prod" data-pid="' + p.id + '"><span class="prod-name">' + esc(p.name) + '</span><span class="prod-price">' + money(p.price) + ' / ' + esc(p.unit) + '</span><span class="prod-badge"></span></button>';
    }).join('') + '</div><div id="cartBox"></div>';
    $('.product-grid', body).onclick = function (e) {
      var b = e.target.closest('[data-pid]'); if (!b) return;
      entry.cart.set(b.dataset.pid, round2((entry.cart.get(b.dataset.pid) || 0) + 1));
      renderCart();
    };
    renderCart();
  }

  function renderCart() {
    var box = $('#cartBox'); if (!box) return;
    var lines = [];
    entry.cart.forEach(function (qty, pid) { var p = getProduct(pid); if (p && p.is_active) lines.push({ p: p, qty: qty }); });
    var total = lines.reduce(function (s, l) { return s + round2(l.qty * Number(l.p.price)); }, 0);
    $$('.prod').forEach(function (b) {
      var q2 = entry.cart.get(b.dataset.pid);
      b.classList.toggle('in-cart', !!q2);
      $('.prod-badge', b).textContent = q2 ? num(q2) : '';
    });
    if (!lines.length) { box.innerHTML = '<div class="cart muted" style="text-align:center">Tap products above to add them to the bill.</div>'; return; }
    box.innerHTML = '<div class="cart">' + lines.map(function (l) {
      return '<div class="cart-line" data-line="' + l.p.id + '"><div class="name">' + esc(l.p.name) + '<small class="muted">' + money(l.p.price) + ' each</small></div>' +
        '<div class="qty"><button type="button" data-dec aria-label="Decrease">−</button><input type="number" inputmode="decimal" step="0.5" min="0.5" value="' + num(l.qty) + '" aria-label="Quantity"><button type="button" data-inc aria-label="Increase">+</button></div>' +
        '<div><b>' + money(l.qty * l.p.price) + '</b> <button type="button" class="icon-btn" data-rm aria-label="Remove">🗑</button></div></div>';
    }).join('') + '<div class="cart-total"><span>Total</span><span>' + money(total) + '</span></div></div>' +
      '<div class="field" style="margin-top:14px"><label for="entryNote">Note (optional)</label><input id="entryNote" type="text" maxlength="300" value="' + esc(entry.note) + '" placeholder="e.g. for the office group"></div>' +
      '<button class="btn primary block" id="submitPurchase">Record purchase · ' + money(total) + '</button>';
    box.onclick = function (e) {
      var line = e.target.closest('[data-line]'); if (!line) return;
      var pid = line.dataset.line, cur = entry.cart.get(pid) || 0;
      if (e.target.closest('[data-inc]')) entry.cart.set(pid, round2(cur + 1));
      else if (e.target.closest('[data-dec]')) { if (cur - 1 <= 0) entry.cart.delete(pid); else entry.cart.set(pid, round2(cur - 1)); }
      else if (e.target.closest('[data-rm]')) entry.cart.delete(pid);
      else return;
      renderCart();
    };
    box.onchange = function (e) {
      var line = e.target.closest('[data-line]'); if (!line || e.target.type !== 'number') return;
      var v = round2(Number(e.target.value));
      if (!(v > 0) || v > 1000) { if (!(v > 0)) entry.cart.delete(line.dataset.line); else toast('Quantity can be at most 1000.', 'error'); }
      else entry.cart.set(line.dataset.line, v);
      renderCart();
    };
    $('#entryNote').oninput = function (e) { entry.note = e.target.value; };
    $('#submitPurchase').onclick = function (e) { submitPurchase(e.currentTarget); };
  }

  function submitPurchase(btn) {
    var c = getCustomer(entry.customerId); if (!c) return;
    var items = [];
    entry.cart.forEach(function (quantity, product_id) { items.push({ product_id: product_id, quantity: quantity }); });
    if (!items.length) return toast('Add at least one product.', 'error');
    var note = entry.note.trim();
    if (note.length > 300) return toast('Note is too long (max 300 characters).', 'error');
    var rid = requestIdFor('purchase', JSON.stringify([c.customer_id, items, note]));
    return withBusy(btn, function () {
      return q(sb.rpc('record_purchase', { p_customer: c.customer_id, p_items: items, p_note: note || null, p_request_id: rid })).then(function () {
        entry.cart.clear(); entry.note = ''; clearRequest('purchase');
        toast('Purchase recorded for ' + c.full_name + '.', 'success');
        return refreshAfterEntry();
      }).catch(function (err) { handleError(err); });
    });
  }

  function renderPaymentForm(body, c) {
    var due = Number(c.balance);
    body.innerHTML = '<form id="payForm" novalidate>' +
      '<div class="field"><label for="payAmt">Amount received (₹)</label><input id="payAmt" class="input big-input" type="text" inputmode="decimal" placeholder="0.00" autocomplete="off"></div>' +
      (due > 0 ? '<div class="toolbar"><button type="button" class="btn sm" id="payFull">Full due · ' + money(due) + '</button></div>' : '') +
      '<div class="field"><span class="label">Method</span><div class="seg">' + PAY_METHODS.map(function (m, i) {
        return '<label><input type="radio" name="payMethod" value="' + m + '"' + (i === 0 ? ' checked' : '') + '><span>' + m + '</span></label>';
      }).join('') + '</div></div>' +
      '<div class="field"><label for="payNote">Note (optional)</label><input id="payNote" type="text" maxlength="300"></div>' +
      '<div class="error-text" id="payErr" role="alert"></div>' +
      '<button class="btn primary block" type="submit">Record payment</button></form>';
    var full = $('#payFull', body); if (full) full.onclick = function () { $('#payAmt', body).value = due.toFixed(2); };
    $('#payForm', body).onsubmit = function (e) {
      e.preventDefault();
      var err = $('#payErr', body); err.textContent = '';
      var amt = parseAmount($('#payAmt', body).value);
      if (isNaN(amt)) { err.textContent = 'Enter a valid amount (₹0.01 to ₹10,00,000, up to 2 decimals).'; return; }
      var method = $('input[name=payMethod]:checked', body).value;
      var note = $('#payNote', body).value.trim();
      var go = amt > due && due >= 0 ? confirmDialog('This is more than the amount due (' + money(due) + '). The customer will be left with an advance of ' + money(amt - due) + '. Continue?', 'Record payment') : Promise.resolve(true);
      go.then(function (ok) {
        if (!ok) return;
        var rid = requestIdFor('payment', JSON.stringify([c.customer_id, amt, method, note]));
        return withBusy($('button[type=submit]', body), function () {
          return q(sb.rpc('record_payment', { p_customer: c.customer_id, p_amount: amt, p_method: method, p_note: note || null, p_request_id: rid })).then(function () {
            clearRequest('payment');
            toast(money(amt) + ' received from ' + c.full_name + ' (' + method + ').', 'success');
            return refreshAfterEntry();
          }).catch(function (e2) { if (e2.expired) handleError(e2); else err.textContent = e2.message; });
        });
      });
    };
  }

  function renderAdjustmentForm(body, c) {
    body.innerHTML = '<form id="adjForm" novalidate><p class="hint">Use adjustments for corrections that are not a purchase or payment (e.g. opening balance, goodwill discount).</p>' +
      '<div class="field"><label for="adjDir">Type</label><select id="adjDir"><option value="debit">Debit — customer owes more</option><option value="credit">Credit — customer owes less</option></select></div>' +
      '<div class="field"><label for="adjAmt">Amount (₹)</label><input id="adjAmt" class="input" type="text" inputmode="decimal" placeholder="0.00" autocomplete="off"></div>' +
      '<div class="field"><label for="adjNote">Reason (required)</label><input id="adjNote" type="text" maxlength="300"></div>' +
      '<div class="error-text" id="adjErr" role="alert"></div>' +
      '<button class="btn primary block" type="submit">Record adjustment</button></form>';
    $('#adjForm', body).onsubmit = function (e) {
      e.preventDefault();
      var err = $('#adjErr', body); err.textContent = '';
      var amt = parseAmount($('#adjAmt', body).value), note = $('#adjNote', body).value.trim(), dir = $('#adjDir', body).value;
      if (isNaN(amt)) { err.textContent = 'Enter a valid amount (₹0.01 to ₹10,00,000, up to 2 decimals).'; return; }
      if (note.length < 3) { err.textContent = 'Please give a reason (at least 3 characters).'; return; }
      var rid = requestIdFor('adjustment', JSON.stringify([c.customer_id, dir, amt, note]));
      withBusy($('button[type=submit]', body), function () {
        return q(sb.rpc('record_adjustment', { p_customer: c.customer_id, p_direction: dir, p_amount: amt, p_note: note, p_request_id: rid })).then(function () {
          clearRequest('adjustment'); toast('Adjustment recorded.', 'success'); return refreshAfterEntry();
        }).catch(function (e2) { if (e2.expired) handleError(e2); else err.textContent = e2.message; });
      });
    };
  }

  /* ------------------------------------------------------------------ */
  /* OWNER: Customers                                                    */
  /* ------------------------------------------------------------------ */
  function viewCustomers(el, r, alive) {
    if (r.id) return viewCustomerLedger(el, r, alive);
    return loadCustomers().then(function () {
      if (!alive()) return;
      el.innerHTML = '<div class="toolbar"><input type="search" id="custFilter" class="input grow" placeholder="Search by name, mobile or username…" aria-label="Search customers">' +
        '<select id="custStatus" class="input" aria-label="Filter"><option value="active">Active</option><option value="due">With dues</option><option value="all">All</option><option value="inactive">Inactive</option></select>' +
        '<button class="btn primary" id="addCust">+ Add customer</button><button class="btn" id="expCust">⬇ Export CSV</button></div><div id="custTable"></div>';
      function filtered() {
        var term = $('#custFilter', el).value.trim().toLowerCase(), st = $('#custStatus', el).value;
        return state.customers.filter(function (c) {
          if (st === 'active' && !c.is_active) return false;
          if (st === 'inactive' && c.is_active) return false;
          if (st === 'due' && !(Number(c.balance) > 0)) return false;
          return !term || [c.full_name, c.mobile, c.username].some(function (v) { return (v || '').toLowerCase().indexOf(term) !== -1; });
        });
      }
      function draw() {
        var rows = filtered(), host = $('#custTable', el);
        if (!rows.length) {
          host.innerHTML = state.customers.length ? emptyHTML('🔍', 'No matching customers', 'Try a different search or filter.') :
            emptyHTML('👥', 'No customers yet', 'Add your first regular customer to start their khata.', '<button class="btn primary" id="addCust2">+ Add customer</button>');
          var a2 = $('#addCust2', host); if (a2) a2.onclick = function () { openCustomerForm(null, refresh); };
          return;
        }
        host.innerHTML = '<div class="card" style="padding:0"><div class="table-wrap"><table class="table stack"><thead><tr><th>Name</th><th>Mobile</th><th class="num">Balance</th><th>Last activity</th><th>Status</th><th></th></tr></thead><tbody>' +
          rows.map(function (c) {
            return '<tr><td data-label="Name"><a href="#/customers/' + c.customer_id + '"><b>' + esc(c.full_name) + '</b></a>' + (c.username ? '<br><small class="muted">@' + esc(c.username) + '</small>' : '') + '</td>' +
              '<td data-label="Mobile">' + esc(c.mobile) + '</td>' +
              '<td data-label="Balance" class="num"><span class="' + balClass(c.balance) + '">' + money(Math.abs(c.balance)) + '</span> <small class="muted">' + balLabel(c.balance) + '</small></td>' +
              '<td data-label="Last activity">' + (c.last_activity ? fmtDate(c.last_activity) : '—') + '</td>' +
              '<td data-label="Status">' + (c.is_active ? '<span class="badge green">Active</span>' : '<span class="badge gray">Inactive</span>') + (c.must_change_password ? ' <span class="badge orange">New</span>' : '') + '</td>' +
              '<td class="actions-cell"><div class="actions"><a class="btn sm" href="#/entry/' + c.customer_id + '">Entry</a><a class="btn sm" href="#/customers/' + c.customer_id + '">Ledger</a><button class="btn sm ghost" data-edit="' + c.customer_id + '">Edit</button></div></td></tr>';
          }).join('') + '</tbody></table></div></div>';
      }
      function refresh() { return loadCustomers().then(function () { if (alive()) draw(); }); }
      $('#custFilter', el).oninput = debounce(draw, 150);
      $('#custStatus', el).onchange = draw;
      $('#addCust', el).onclick = function () { openCustomerForm(null, refresh); };
      $('#expCust', el).onclick = function () {
        var rows = filtered();
        if (!rows.length) return toast('No customers to export.', 'error');
        downloadCSV('customers-' + todayISO() + '.csv', ['Name', 'Mobile', 'Username', 'Status', 'Total purchases (Rs)', 'Total payments (Rs)', 'Balance (Rs)', 'Last activity'],
          rows.map(function (c) { return [c.full_name, c.mobile, c.username || '', c.is_active ? 'Active' : 'Inactive', Number(c.total_purchases), Number(c.total_payments), Number(c.balance), c.last_activity ? fmtISODate(new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(c.last_activity))) : '']; }));
      };
      el.addEventListener('click', function (e) {
        var b = e.target.closest('[data-edit]'); if (!b) return;
        var c = getCustomer(b.dataset.edit); if (c) openCustomerForm(c, refresh);
      });
      draw();
    });
  }

  function showCredentials(heading, c, intro) {
    var base = location.origin + location.pathname;
    var msg = 'Hello ' + c.full_name + ', your Chai Khata login:\nLogin: ' + c.mobile + (c.username ? ' (or ' + c.username + ')' : '') + '\nPassword: ' + c.initial_password + '\nOpen: ' + base + '\nYou will be asked to set a new password after your first login.';
    openModal({
      title: heading,
      html: '<p>' + esc(intro) + '</p><div class="cred-box"><div class="cred-row"><span>Name</span><b style="font-family:inherit">' + esc(c.full_name) + '</b></div>' +
        '<div class="cred-row"><span>Login</span><b>' + esc(c.mobile) + '</b></div>' +
        (c.username ? '<div class="cred-row"><span>Username</span><b>' + esc(c.username) + '</b></div>' : '') +
        '<div class="cred-row"><span>Password</span><b>' + esc(c.initial_password) + '</b></div></div>' +
        '<p class="hint">Shown only once. The customer must set a new password at first login.</p>' +
        '<div class="form-actions"><button class="btn" id="copyCred">Copy details</button><a class="btn primary" target="_blank" rel="noopener" href="https://wa.me/91' + esc(c.mobile) + '?text=' + encodeURIComponent(msg) + '">Send on WhatsApp</a></div>',
      onMount: function (b) {
        $('#copyCred', b).onclick = function () { copyText(msg).then(function () { toast('Copied.', 'success'); }, function () { toast('Could not copy.', 'error'); }); };
      }
    });
  }

  function openCustomerForm(c, done) {
    var editing = !!c;
    openModal({
      title: editing ? 'Edit customer' : 'Add customer',
      html: '<form id="custForm" novalidate>' +
        '<div class="field"><label for="cfName">Full name</label><input id="cfName" type="text" maxlength="80" required value="' + esc(c ? c.full_name : '') + '"></div>' +
        '<div class="field"><label for="cfMobile">Mobile number</label><input id="cfMobile" type="tel" inputmode="numeric" maxlength="14" required value="' + esc(c ? c.mobile : '') + '"' + (editing ? ' disabled' : '') + '>' +
        (editing ? '<span class="hint">Mobile number is their login and cannot be changed.</span>' : '') + '</div>' +
        '<div class="field"><label for="cfUser">Username (optional)</label><input id="cfUser" type="text" maxlength="30" autocapitalize="none" placeholder="e.g. ramesh.k" value="' + esc(c && c.username ? c.username : '') + '"><span class="hint">3–30 characters: letters, digits, dot or underscore.</span></div>' +
        '<div class="field"><label for="cfNotes">Notes (optional)</label><textarea id="cfNotes" maxlength="300">' + esc(c && c.notes ? c.notes : '') + '</textarea></div>' +
        (editing ? '<label class="check"><input type="checkbox" id="cfActive"' + (c.is_active ? ' checked' : '') + '> Active (can sign in and be billed)</label>' :
          '<div class="cred-box"><div class="hint">Initial password (customer must change it at first login)</div><b id="cfPreview" style="font-family:ui-monospace,Menlo,monospace;font-size:18px">—</b></div>') +
        '<div class="error-text" id="cfErr" role="alert"></div>' +
        '<div class="form-actions">' + (editing ? '<button type="button" class="btn ghost" id="cfReset">Reset password</button>' : '') +
        '<button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary" type="submit">' + (editing ? 'Save changes' : 'Create customer') + '</button></div></form>',
      onMount: function (b, close) {
        var err = $('#cfErr', b);
        function preview() {
          var p = $('#cfPreview', b); if (!p) return;
          var m = normalizeMobile($('#cfMobile', b).value), n = $('#cfName', b).value;
          p.textContent = m && n.trim().length >= 2 ? initialPassword(n, m) : '—';
        }
        $('#cfName', b).addEventListener('input', preview); $('#cfMobile', b).addEventListener('input', preview);
        if ($('#cfReset', b)) $('#cfReset', b).onclick = function () {
          confirmDialog('Reset the password for ' + c.full_name + '? They will be given a temporary password and must change it at next login.', 'Reset password').then(function (ok) {
            if (!ok) return;
            withBusy($('#cfReset', b), function () {
              return invokeFn('reset-customer-password', { customer_id: c.customer_id }).then(function (res) {
                close(); showCredentials('Password reset', res, 'Give this temporary password to the customer.'); if (done) done();
              }).catch(function (e) { if (e.expired) handleError(e); else err.textContent = e.message; });
            });
          });
        };
        $('#custForm', b).onsubmit = function (e) {
          e.preventDefault(); err.textContent = '';
          var name = $('#cfName', b).value.trim().replace(/\s+/g, ' '), user = $('#cfUser', b).value.trim().toLowerCase(), notes = $('#cfNotes', b).value.trim();
          if (name.length < 2) { err.textContent = 'Enter the customer’s full name.'; return; }
          var mobile = editing ? c.mobile : normalizeMobile($('#cfMobile', b).value);
          if (!mobile) { err.textContent = 'Enter a valid 10-digit Indian mobile number (starting 6–9).'; return; }
          if (user && !/^[a-z][a-z0-9._]{2,29}$/.test(user)) { err.textContent = 'Username: 3–30 characters, letters/digits/dot/underscore, starting with a letter.'; return; }
          withBusy($('button[type=submit]', b), function () {
            if (editing) {
              return q(sb.from('profiles').update({ full_name: name, username: user || null, notes: notes || null, is_active: $('#cfActive', b).checked }).eq('id', c.customer_id)).then(function () {
                toast('Customer updated.', 'success'); close(); if (done) done();
              }).catch(function (e2) { if (e2.expired) handleError(e2); else err.textContent = e2.message; });
            }
            return invokeFn('create-customer', { full_name: name, mobile: mobile, username: user || null, notes: notes || null }).then(function (res) {
              close(); showCredentials('Customer created', res, 'Share these login details with the customer.'); if (done) done();
            }).catch(function (e2) { if (e2.expired) handleError(e2); else err.textContent = e2.message; });
          });
        };
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* OWNER: Single customer ledger                                       */
  /* ------------------------------------------------------------------ */
  function viewCustomerLedger(el, r, alive) {
    return Promise.all([
      q(sb.from('customer_balances').select('*').eq('customer_id', r.id).maybeSingle()),
      fetchAll(function () { return sb.from('transactions').select('*, transaction_items(id,product_name,quantity,unit_price,line_total)').eq('customer_id', r.id).order('created_at', { ascending: true }).order('id'); })
    ]).then(function (res) {
      if (!alive()) return;
      var c = res[0], txs = res[1];
      if (!c) { el.innerHTML = emptyHTML('🔍', 'Customer not found', 'This customer does not exist or you cannot access it.', '<a class="btn" href="#/customers">Back to customers</a>'); return; }
      el.innerHTML = '<div class="page-head"><div><a href="#/customers">← Customers</a><h2>' + esc(c.full_name) + '</h2><div class="muted">' + esc(c.mobile) + (c.username ? ' · @' + esc(c.username) : '') + (c.is_active ? '' : ' · <span class="badge gray">Inactive</span>') + '</div></div>' +
        '<div class="actions"><a class="btn primary" href="#/entry/' + c.customer_id + '">➕ New entry</a></div></div>' +
        '<div class="stats three"><div class="stat"><div class="label">Total purchases</div><div class="value">' + money(c.total_purchases) + '</div></div>' +
        '<div class="stat"><div class="label">Total payments</div><div class="value">' + money(c.total_payments) + '</div></div>' +
        '<div class="stat accent"><div class="label">' + balLabel(c.balance) + '</div><div class="value">' + money(Math.abs(c.balance)) + '</div></div></div>' +
        (c.notes ? '<p class="muted">Note: ' + esc(c.notes) + '</p>' : '') + '<div id="ledgerHost"></div>';
      renderLedgerPanel($('#ledgerHost', el), txs, {
        owner: true, csvName: 'ledger-' + c.full_name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        onReverse: function (t) { openReverseModal(t, route); }
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* OWNER: Transactions (all)                                           */
  /* ------------------------------------------------------------------ */
  function viewTransactions(el, r, alive) {
    var from = addDays(todayISO(), -30), to = todayISO();
    el.innerHTML = '<div class="toolbar"><label class="field-inline">From <input type="date" id="txFrom" class="input" value="' + from + '"></label>' +
      '<label class="field-inline">To <input type="date" id="txTo" class="input" value="' + to + '"></label>' +
      '<select id="txType" class="input" aria-label="Type"><option value="">All types</option><option value="purchase">Purchases</option><option value="payment">Payments</option><option value="adjustment">Adjustments</option><option value="reversal">Reversals</option></select>' +
      '<input type="search" id="txSearch" class="input grow" placeholder="Search customer…" aria-label="Search customer">' +
      '<button class="btn" id="txCsv">⬇ Export CSV</button></div><div id="txHost">' + loadingHTML() + '</div>';
    var rows = [];
    function filtered() {
      var type = $('#txType', el).value, term = $('#txSearch', el).value.trim().toLowerCase();
      return rows.filter(function (t) {
        if (type === 'adjustment' && t.kind !== 'debit_adjustment' && t.kind !== 'credit_adjustment') return false;
        if (type && type !== 'adjustment' && t.kind !== type) return false;
        return !term || (t.customer && (t.customer.full_name + ' ' + t.customer.mobile).toLowerCase().indexOf(term) !== -1);
      });
    }
    function draw() {
      var host = $('#txHost', el), list = filtered();
      if (!list.length) { host.innerHTML = emptyHTML('🧾', 'No transactions found', 'Try a wider date range or different filters.'); return; }
      var shown = list.slice(0, 300);
      host.innerHTML = '<div class="card" style="padding:0"><div class="table-wrap"><table class="table stack"><thead><tr><th>Date</th><th>Time</th><th>Customer</th><th>Type</th><th>Details</th><th class="num">Amount</th><th></th></tr></thead><tbody>' +
        shown.map(function (t) {
          var e = Number(t.balance_effect);
          return '<tr class="' + (t.is_reversed ? 'reversed' : '') + '"><td data-label="Date">' + fmtDate(t.created_at) + '</td><td data-label="Time">' + fmtTime(t.created_at) + '</td>' +
            '<td data-label="Customer">' + (t.customer ? '<a href="#/customers/' + t.customer_id + '">' + esc(t.customer.full_name) + '</a>' : '—') + '</td>' +
            '<td data-label="Type">' + esc(txLabel(t)) + (t.is_reversed ? ' <span class="badge gray">Reversed</span>' : '') + '</td>' +
            '<td data-label="Details">' + esc(txDetails(t)) + (t.note ? '<br><small class="muted">' + esc(t.note) + '</small>' : '') + '</td>' +
            '<td data-label="Amount" class="num strike"><span class="amt ' + (e > 0 ? 'debit' : 'credit') + '">' + (e > 0 ? '+' : '−') + money(Math.abs(e)) + '</span></td>' +
            '<td class="actions-cell">' + (t.kind !== 'reversal' && !t.is_reversed ? '<button class="btn sm ghost" data-reverse="' + t.id + '">Reverse</button>' : '') + '</td></tr>';
        }).join('') + '</tbody></table></div></div>' + (list.length > shown.length ? '<p class="muted" style="text-align:center">Showing the latest 300 of ' + list.length + '. Narrow the dates or export CSV for everything.</p>' : '');
    }
    function load() {
      var f = $('#txFrom', el).value, t = $('#txTo', el).value;
      if (!f || !t || f > t) { toast('Choose a valid date range.', 'error'); return Promise.resolve(); }
      $('#txHost', el).innerHTML = loadingHTML();
      return fetchAll(function () { return sb.from('transactions').select(TX_SELECT).gte('txn_date', f).lte('txn_date', t).order('created_at', { ascending: false }).order('id'); }, 1000, 20000).then(function (data) {
        if (!alive()) return; rows = data; draw();
      }).catch(function (err) { if (!alive()) return; if (err.expired) handleError(err); else $('#txHost', el).innerHTML = '<div class="error-box">' + esc(err.message) + '<br><button class="btn" id="txRetry">Try again</button></div>', $('#txRetry', el).onclick = load; });
    }
    $('#txFrom', el).onchange = load; $('#txTo', el).onchange = load;
    $('#txType', el).onchange = draw; $('#txSearch', el).oninput = debounce(draw, 150);
    $('#txCsv', el).onclick = function () {
      var list = filtered(); if (!list.length) return toast('Nothing to export.', 'error');
      var out = [];
      list.forEach(function (t) {
        var base = [fmtISODate(t.txn_date), fmtTime(t.created_at), t.customer ? t.customer.full_name : '', t.customer ? t.customer.mobile : '', txLabel(t) + (t.is_reversed ? ' (reversed)' : ''), t.payment_method || ''];
        var e = Number(t.balance_effect), items = t.transaction_items || [];
        if (items.length) items.forEach(function (i, idx) { out.push(base.concat([i.product_name, Number(i.quantity), Number(i.unit_price), Number(i.line_total), idx === 0 ? (e > 0 ? e : '') : '', '', t.note || ''])); });
        else out.push(base.concat(['', '', '', '', e > 0 ? e : '', e < 0 ? -e : '', t.note || '']));
      });
      downloadCSV('transactions-' + $('#txFrom', el).value + '-to-' + $('#txTo', el).value + '.csv',
        ['Date', 'Time', 'Customer', 'Mobile', 'Type', 'Method', 'Product', 'Qty', 'Unit price (Rs)', 'Line total (Rs)', 'Charge (Rs)', 'Credit (Rs)', 'Note'], out);
    };
    el.addEventListener('click', function (e) {
      var b = e.target.closest('[data-reverse]'); if (!b) return;
      var t = rows.find(function (x) { return x.id === b.dataset.reverse; });
      if (t) openReverseModal(t, load);
    });
    return load();
  }

  /* ------------------------------------------------------------------ */
  /* OWNER: Products                                                     */
  /* ------------------------------------------------------------------ */
  function viewProducts(el, r, alive) {
    return loadProducts().then(function () {
      if (!alive()) return;
      el.innerHTML = '<div class="toolbar"><input type="search" id="pFilter" class="input grow" placeholder="Search products…" aria-label="Search products"><button class="btn primary" id="addProd">+ Add product</button></div>' +
        '<p class="hint">Price changes apply to future purchases only. Past bills keep the price they were sold at.</p><div id="prodTable"></div>';
      function draw() {
        var term = $('#pFilter', el).value.trim().toLowerCase();
        var rows = state.products.filter(function (p) { return !term || p.name.toLowerCase().indexOf(term) !== -1; });
        var host = $('#prodTable', el);
        if (!rows.length) { host.innerHTML = state.products.length ? emptyHTML('🔍', 'No matching products', '') : emptyHTML('☕', 'No products yet', 'Add tea, coffee, biscuits, cigarettes and snacks with their prices.', '<button class="btn primary" id="addProd2">+ Add product</button>'); var a = $('#addProd2', host); if (a) a.onclick = function () { openProductForm(null, refresh); }; return; }
        host.innerHTML = '<div class="card" style="padding:0"><div class="table-wrap"><table class="table stack"><thead><tr><th>Product</th><th class="num">Price</th><th>Unit</th><th>Status</th><th>Updated</th><th></th></tr></thead><tbody>' +
          rows.map(function (p) {
            return '<tr><td data-label="Product"><b>' + esc(p.name) + '</b></td><td data-label="Price" class="num">' + money(p.price) + '</td><td data-label="Unit">' + esc(p.unit) + '</td>' +
              '<td data-label="Status">' + (p.is_active ? '<span class="badge green">Active</span>' : '<span class="badge gray">Hidden</span>') + '</td><td data-label="Updated">' + fmtDate(p.updated_at) + '</td>' +
              '<td class="actions-cell"><div class="actions"><button class="btn sm" data-pedit="' + p.id + '">Edit / price</button><button class="btn sm ghost" data-ptoggle="' + p.id + '">' + (p.is_active ? 'Hide' : 'Show') + '</button></div></td></tr>';
          }).join('') + '</tbody></table></div></div>';
      }
      function refresh() { return loadProducts().then(function () { if (alive()) draw(); }); }
      $('#pFilter', el).oninput = debounce(draw, 150);
      $('#addProd', el).onclick = function () { openProductForm(null, refresh); };
      el.addEventListener('click', function (e) {
        var ed = e.target.closest('[data-pedit]'), tg = e.target.closest('[data-ptoggle]');
        if (ed) openProductForm(getProduct(ed.dataset.pedit), refresh);
        if (tg) {
          var p = getProduct(tg.dataset.ptoggle); if (!p) return;
          withBusy(tg, function () {
            return q(sb.from('products').update({ is_active: !p.is_active }).eq('id', p.id)).then(function () { toast(p.name + (p.is_active ? ' hidden from new bills.' : ' is active again.'), 'success'); return refresh(); }).catch(function (err) { handleError(err); });
          });
        }
      });
      draw();
    });
  }

  function openProductForm(p, done) {
    var editing = !!p;
    openModal({
      title: editing ? 'Edit product' : 'Add product',
      html: '<form id="prodForm" novalidate><div class="field"><label for="pfName">Name</label><input id="pfName" type="text" maxlength="60" required value="' + esc(p ? p.name : '') + '" placeholder="e.g. Special Chai"></div>' +
        '<div class="field"><label for="pfPrice">Price (₹)</label><input id="pfPrice" class="input" type="text" inputmode="decimal" required value="' + (p ? Number(p.price).toFixed(2) : '') + '" placeholder="0.00"></div>' +
        '<div class="field"><label for="pfUnit">Unit</label><input id="pfUnit" type="text" list="units" maxlength="20" value="' + esc(p ? p.unit : 'piece') + '"><datalist id="units"><option value="cup"><option value="piece"><option value="packet"><option value="plate"><option value="glass"></datalist></div>' +
        '<div class="error-text" id="pfErr" role="alert"></div><div class="form-actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary" type="submit">' + (editing ? 'Save' : 'Add product') + '</button></div></form>',
      onMount: function (b, close) {
        $('#prodForm', b).onsubmit = function (e) {
          e.preventDefault();
          var err = $('#pfErr', b); err.textContent = '';
          var name = $('#pfName', b).value.trim().replace(/\s+/g, ' '), unit = $('#pfUnit', b).value.trim() || 'piece';
          var priceStr = $('#pfPrice', b).value.replace(/,/g, '').trim(), price = Number(priceStr);
          if (!name) { err.textContent = 'Enter a product name.'; return; }
          if (!/^\d+(\.\d{1,2})?$/.test(priceStr) || price > 100000) { err.textContent = 'Enter a valid price (up to 2 decimals, max ₹1,00,000).'; return; }
          withBusy($('button[type=submit]', b), function () {
            var op = editing ? sb.from('products').update({ name: name, price: price, unit: unit }).eq('id', p.id) : sb.from('products').insert({ name: name, price: price, unit: unit });
            return q(op).then(function () { toast(editing ? 'Product updated.' : 'Product added.', 'success'); close(); if (done) done(); })
              .catch(function (e2) { if (e2.expired) handleError(e2); else err.textContent = e2.message; });
          });
        };
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* OWNER: Reports                                                      */
  /* ------------------------------------------------------------------ */
  function viewReports(el, r, alive) {
    var from = addDays(todayISO(), -6), to = todayISO();
    el.innerHTML = '<div class="toolbar"><label class="field-inline">From <input type="date" id="rpFrom" class="input" value="' + from + '"></label>' +
      '<label class="field-inline">To <input type="date" id="rpTo" class="input" value="' + to + '"></label>' +
      '<button class="btn primary" id="rpRun">Run report</button><button class="btn" id="rpCsv">⬇ Daily sales CSV</button><button class="btn" id="rpDues">⬇ Outstanding CSV</button></div><div id="rpHost">' + loadingHTML() + '</div>';
    var data = [];
    function draw() {
      var host = $('#rpHost', el);
      if (!data.length) { host.innerHTML = emptyHTML('📊', 'No sales in this period', 'Try a wider date range.'); return; }
      var tot = data.reduce(function (s, d) { s.sales += Number(d.sales); s.col += Number(d.collections); s.bills += d.bills; s.cash += Number(d.cash_amt); s.upi += Number(d.upi_amt); s.oth += Number(d.other_amt); return s; }, { sales: 0, col: 0, bills: 0, cash: 0, upi: 0, oth: 0 });
      host.innerHTML = '<div class="stats"><div class="stat accent"><div class="label">Sales</div><div class="value">' + money(tot.sales) + '</div><div class="sub">' + tot.bills + ' bills</div></div>' +
        '<div class="stat"><div class="label">Collected</div><div class="value">' + money(tot.col) + '</div></div>' +
        '<div class="stat"><div class="label">Cash / UPI / Other</div><div class="value" style="font-size:16px">' + money(tot.cash) + ' / ' + money(tot.upi) + ' / ' + money(tot.oth) + '</div></div>' +
        '<div class="stat"><div class="label">Avg daily sales</div><div class="value">' + money(tot.sales / data.length) + '</div></div></div>' +
        '<div class="card" style="padding:0"><div class="table-wrap"><table class="table stack"><thead><tr><th>Date</th><th class="num">Bills</th><th class="num">Sales</th><th class="num">Collected</th><th class="num">Cash</th><th class="num">UPI</th><th class="num">Other</th></tr></thead><tbody>' +
        data.map(function (d) {
          return '<tr><td data-label="Date">' + fmtISODate(d.day) + '</td><td data-label="Bills" class="num">' + d.bills + '</td><td data-label="Sales" class="num"><b>' + money(d.sales) + '</b></td><td data-label="Collected" class="num">' + money(d.collections) + '</td><td data-label="Cash" class="num">' + money(d.cash_amt) + '</td><td data-label="UPI" class="num">' + money(d.upi_amt) + '</td><td data-label="Other" class="num">' + money(d.other_amt) + '</td></tr>';
        }).join('') + '</tbody></table></div></div><p class="hint">Reversals are counted on the day they are made, so corrections net out the original entry.</p>';
    }
    function run() {
      var f = $('#rpFrom', el).value, t = $('#rpTo', el).value;
      if (!f || !t || f > t) { toast('Choose a valid date range.', 'error'); return Promise.resolve(); }
      $('#rpHost', el).innerHTML = loadingHTML();
      return q(sb.rpc('report_daily', { p_from: f, p_to: t })).then(function (rows) { if (!alive()) return; data = rows; draw(); })
        .catch(function (err) { if (!alive()) return; if (err.expired) handleError(err); else { $('#rpHost', el).innerHTML = '<div class="error-box">' + esc(err.message) + '</div>'; } });
    }
    $('#rpRun', el).onclick = run;
    $('#rpCsv', el).onclick = function () {
      if (!data.length) return toast('Run the report first — no data to export.', 'error');
      downloadCSV('daily-sales-' + $('#rpFrom', el).value + '-to-' + $('#rpTo', el).value + '.csv', ['Date', 'Bills', 'Sales (Rs)', 'Collected (Rs)', 'Cash (Rs)', 'UPI (Rs)', 'Other (Rs)'],
        data.map(function (d) { return [fmtISODate(d.day), d.bills, Number(d.sales), Number(d.collections), Number(d.cash_amt), Number(d.upi_amt), Number(d.other_amt)]; }));
    };
    $('#rpDues', el).onclick = function (e) {
      withBusy(e.currentTarget, function () {
        return loadCustomers().then(function (cs) {
          var rows = cs.filter(function (c) { return Number(c.balance) !== 0; }).sort(function (a, b) { return b.balance - a.balance; });
          if (!rows.length) return toast('No outstanding balances.', 'info');
          downloadCSV('outstanding-' + todayISO() + '.csv', ['Customer', 'Mobile', 'Balance (Rs)', 'Status'], rows.map(function (c) { return [c.full_name, c.mobile, Number(c.balance), balLabel(c.balance)]; }));
        }).catch(function (err) { handleError(err); });
      });
    };
    return run();
  }

  /* ------------------------------------------------------------------ */
  /* OWNER: Settings                                                     */
  /* ------------------------------------------------------------------ */
  function viewSettings(el) {
    el.innerHTML = '<div class="two-col"><section class="card"><h2 class="card-title">Stall</h2><form id="stallForm" novalidate>' +
      '<div class="field"><label for="stName">Stall name</label><input id="stName" type="text" maxlength="80" value="' + esc(state.stall.name) + '"></div>' +
      '<div class="error-text" id="stErr"></div><button class="btn primary" type="submit">Save</button></form>' +
      '<div class="divider"></div><dl class="kv"><dt>Signed in as</dt><dd>' + esc(state.profile.full_name) + '</dd><dt>Email</dt><dd>' + esc(state.profile.login_email) + '</dd></dl></section>' +
      '<section class="card"><h2 class="card-title">Change password</h2>' + passwordFormHTML({ recovery: false }) + '</section></div>';
    $('#stallForm', el).onsubmit = function (e) {
      e.preventDefault();
      var name = $('#stName', el).value.trim(), err = $('#stErr', el); err.textContent = '';
      if (name.length < 2) { err.textContent = 'Enter a stall name (at least 2 characters).'; return; }
      withBusy($('button[type=submit]', e.target), function () {
        return q(sb.from('stalls').update({ name: name }).eq('id', state.stall.id)).then(function () { state.stall.name = name; $('.stall-name').textContent = name; toast('Stall name saved.', 'success'); })
          .catch(function (e2) { if (e2.expired) handleError(e2); else err.textContent = e2.message; });
      });
    };
    bindPasswordForm($('section:last-child', el), { recovery: false, onDone: function () { toast('Password updated.', 'success'); $('#pwForm', el).reset(); } });
  }

  /* ------------------------------------------------------------------ */
  /* CUSTOMER views                                                      */
  /* ------------------------------------------------------------------ */
  function viewHome(el, r, alive) {
    return Promise.all([
      q(sb.from('customer_balances').select('*').eq('customer_id', state.profile.id).maybeSingle()),
      fetchAll(function () { return sb.from('transactions').select('*, transaction_items(id,product_name,quantity,unit_price,line_total)').eq('customer_id', state.profile.id).order('created_at', { ascending: true }).order('id'); }),
      refreshNotifications(false)
    ]).then(function (res) {
      if (!alive()) return;
      var bal = res[0] || { total_purchases: 0, total_payments: 0, balance: 0 };
      var recent = buildLedger(res[1]).slice(-5).reverse();
      el.innerHTML = notifBannerHTML() + '<div class="hero"><div class="label">Hello, ' + esc(state.profile.full_name.split(' ')[0]) + ' 👋 — ' + (Number(bal.balance) > 0 ? 'Outstanding balance' : Number(bal.balance) < 0 ? 'Advance with stall' : 'You are all settled') + '</div>' +
        '<div class="big">' + money(Math.abs(bal.balance)) + '</div><div class="sub">at ' + esc(state.stall.name) + '</div></div>' +
        '<div class="stats"><div class="stat"><div class="label">Total purchases</div><div class="value">' + money(bal.total_purchases) + '</div></div><div class="stat"><div class="label">Total payments</div><div class="value">' + money(bal.total_payments) + '</div></div></div>' +
        '<h2 class="card-title" style="margin-top:6px">Recent activity <a class="btn sm ghost" href="#/ledger">Full ledger</a></h2>' +
        (recent.length ? '<div class="ledger">' + recent.map(function (t) { return ledgerCardHTML(t, false); }).join('') + '</div>' : emptyHTML('☕', 'Nothing here yet', 'Your purchases and payments will appear here.'));
      var banner = $('#notifBanner', el);
      if (banner) banner.onclick = openNotifications;
    });
  }

  function viewMyLedger(el, r, alive) {
    return fetchAll(function () { return sb.from('transactions').select('*, transaction_items(id,product_name,quantity,unit_price,line_total)').eq('customer_id', state.profile.id).order('created_at', { ascending: true }).order('id'); }).then(function (txs) {
      if (!alive()) return;
      el.innerHTML = '<div id="ledgerHost"></div>';
      renderLedgerPanel($('#ledgerHost', el), txs, { owner: false, csvName: 'my-ledger' });
    });
  }

  function viewProfile(el) {
    var p = state.profile;
    el.innerHTML = '<section class="card"><h2 class="card-title">My details</h2><dl class="kv"><dt>Name</dt><dd>' + esc(p.full_name) + '</dd><dt>Mobile</dt><dd>' + esc(p.mobile) + '</dd>' +
      (p.username ? '<dt>Username</dt><dd>' + esc(p.username) + '</dd>' : '') + '<dt>Stall</dt><dd>' + esc(state.stall.name) + '</dd><dt>Member since</dt><dd>' + fmtDate(p.created_at) + '</dd></dl>' +
      '<p class="hint" style="margin-top:12px">To change your name or mobile number, please ask the stall owner.</p></section>' +
      '<section class="card" id="pwCard"><h2 class="card-title">Change password</h2>' + passwordFormHTML({ recovery: false }) + '</section>' +
      '<div class="form-actions" style="justify-content:center"><button class="btn danger" id="profOut">Sign out</button></div>';
    bindPasswordForm($('#pwCard', el), { recovery: false, onDone: function () { toast('Password updated.', 'success'); $('#pwForm', el).reset(); } });
    $('#profOut', el).onclick = signOut;
  }

  /* ------------------------------------------------------------------ */
  /* Boot                                                                */
  /* ------------------------------------------------------------------ */
  function boot() {
    var cfg = window.CHAI_CONFIG;
    if (!window.supabase) return showConfigError('The Supabase library could not be loaded. Check your internet connection or ad-blocker and reload.');
    if (!cfg || !cfg.isConfigured || !window.sb) return showConfigError('Supabase is not configured yet.');

    sb.auth.onAuthStateChange(function (event) {
      // Defer: never call Supabase APIs synchronously inside this callback.
      if (event === 'PASSWORD_RECOVERY') { state.recovery = true; setTimeout(renderRecovery, 0); }
      else if (event === 'SIGNED_OUT' && state.profile) setTimeout(function () { forceLogout(SESSION_MSG); }, 0);
    });
    window.addEventListener('hashchange', route);

    sb.auth.getSession().then(function () {
      if (state.recovery) { hideBoot(); return; }
      return startApp().then(hideBoot);
    }).catch(function (err) {
      console.error(err);
      renderLogin('Could not reach the server. Check your connection and try again.', 'error');
    });
  }

  boot();
})();
