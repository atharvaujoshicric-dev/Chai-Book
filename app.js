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
    { id: 'dashboard', label: 'Home', title: 'Dashboard', icon: '\uD83C\uDFE0', bottom: true },
    { id: 'entry', label: 'Entry', title: 'New Entry', icon: '\uFF0B', fab: true },
    { id: 'customers', label: 'Customers', title: 'Customers', icon: '\uD83D\uDC65', bottom: true },
    { id: 'dues', label: 'Dues', title: 'Dues & Reminders', icon: '\uD83D\uDCB0', bottom: true },
    { id: 'transactions', label: 'Transactions', title: 'Transactions', icon: '\uD83E\uDDFE' },
    { id: 'products', label: 'Products', title: 'Products', icon: '\u2615' },
    { id: 'reports', label: 'Reports', title: 'Reports', icon: '\uD83D\uDCCA' },
    { id: 'settings', label: 'Settings', title: 'Settings', icon: '\u2699\uFE0F' }
  ];
  var CUSTOMER_NAV = [
    { id: 'home', label: 'Home', icon: '\uD83C\uDFE0', bottom: true },
    { id: 'ledger', label: 'Ledger', icon: '\uD83D\uDCD2', bottom: true },
    { id: 'profile', label: 'Profile', icon: '\uD83D\uDC64', bottom: true }
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
    done: null,
    method: null,
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
    wrap.addEventListener('click', function (e) { if (e.target.closest('[data-close]')) close(); });
    var body = $('.modal-body', wrap);
    if (opts.onMount) opts.onMount(body, close);
    var first = $('input:not([disabled]):not([type=hidden]):not([type=radio]),select,textarea', body);
    if (first && !/Mobi|Android/i.test(navigator.userAgent)) first.focus();
    return close;
  }

  function closeAllModals() {
    var b, guard = 0;
    while (guard++ < 10 && (b = $('#modal-root .modal-backdrop:last-child .modal-head [data-close]'))) b.click();
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
          else if (!status) msg = 'Could not reach the "' + name + '" function. Quick test: open ' + window.CHAI_CONFIG.SUPABASE_URL.replace(/\/$/, '') + '/functions/v1/' + name + ' in a new browser tab. "Method not allowed" = working (redeploy the latest file); "NOT_FOUND" = not deployed or wrongly named; "Missing authorization header" = turn Verify JWT off and redeploy.';
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
  /* Per-device conveniences (recents, popular products, reminder log)   */
  /* ------------------------------------------------------------------ */
  function lsGet(key, def) { try { var v = localStorage.getItem(key); return v == null ? def : JSON.parse(v); } catch (e) { return def; } }
  function lsSet(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* storage unavailable */ } }
  function ukey(k) { return 'ck_' + k + '_' + (state.profile ? state.profile.id.slice(0, 8) : ''); }
  function istDateOf(ts) { return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(ts)); }
  function isTouch() { return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); }

  function pushRecent(id) {
    var a = lsGet(ukey('recent'), []).filter(function (x) { return x !== id; });
    a.unshift(id); lsSet(ukey('recent'), a.slice(0, 12));
  }
  function getRecents() { return lsGet(ukey('recent'), []).filter(function (id) { var c = getCustomer(id); return c && c.is_active; }); }
  function bumpProducts(ids) { var u = lsGet(ukey('produse'), {}); ids.forEach(function (id) { u[id] = (u[id] || 0) + 1; }); lsSet(ukey('produse'), u); }
  function markReminded(id) { var m = lsGet(ukey('rem'), {}); m[id] = new Date().toISOString(); lsSet(ukey('rem'), m); }
  function remindedAt(id) { return lsGet(ukey('rem'), {})[id] || null; }
  function agoText(ts) {
    if (!ts) return '';
    var d = Math.round((Date.parse(todayISO()) - Date.parse(istDateOf(ts))) / 86400000);
    return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d + ' days ago';
  }
  function initials(name) {
    var p = String(name || '').trim().split(/\s+/);
    return (((p[0] || '?').charAt(0)) + (p.length > 1 ? p[p.length - 1].charAt(0) : '')).toUpperCase();
  }
  function avatarHTML(name) {
    var h = 0, s = String(name || '');
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 6;
    return '<span class="avatar a' + h + '" aria-hidden="true">' + esc(initials(s)) + '</span>';
  }
  function firstName(n) { return String(n || '').trim().split(/\s+/)[0] || ''; }
  function nowStamp() { return fmtDate(Date.now()) + ', ' + fmtTime(Date.now()); }
  function downloadBlob(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1500);
  }

  /* ------------------------------------------------------------------ */
  /* UPI payment QR + WhatsApp reminders                                 */
  /* ------------------------------------------------------------------ */
  function validUpi(v) { return /^[a-zA-Z0-9._-]{2,100}@[a-zA-Z][a-zA-Z0-9]{1,63}$/.test(v); }
  function upiLink(upi, payee, amount, note) {
    var u = 'upi://pay?pa=' + encodeURIComponent(upi).replace(/%40/g, '@') + '&pn=' + encodeURIComponent(payee) + '&cu=INR';
    if (amount > 0) u += '&am=' + Number(amount).toFixed(2);
    if (note) u += '&tn=' + encodeURIComponent(note);
    return u;
  }
  // Link to the stall's own pay page (pay.html next to index.html): WhatsApp makes it tappable, and it shows the QR + a Pay button.
  function payPageUrl(upi, payee, amount) {
    var u = new URL('pay.html', location.href.split('#')[0].split('?')[0]);
    u.searchParams.set('pa', upi); u.searchParams.set('pn', payee); if (amount > 0) u.searchParams.set('am', Number(amount).toFixed(2));
    return u.toString();
  }
  // Draws a shareable "scan to pay" card (stall name, amount, QR, UPI ID) onto a canvas.
  function drawPayCard(canvas, payload, o) {
    if (!window.qrcode) return false;
    var qr;
    try { qr = window.qrcode(0, 'M'); qr.addData(payload); qr.make(); } catch (e) { console.error(e); return false; }
    var n = qr.getModuleCount(), W = 640, cell = Math.floor(440 / n), size = cell * n, quiet = 26;
    var font0 = '"Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', capLines = [];
    if (o.caption && o.caption.length) {      // message text printed under the QR, wrapped to the card width
      var sg = document.createElement('canvas').getContext('2d'); sg.font = '500 27px ' + font0;
      o.caption.forEach(function (para) {
        var words = String(para).split(/\s+/), line = '';
        words.forEach(function (w) { var t = line ? line + ' ' + w : w; if (sg.measureText(t).width > W - 90 && line) { capLines.push(line); line = w; } else line = t; });
        if (line) capLines.push(line);
        capLines.push('');
      });
      capLines.pop();
    }
    var capH = capLines.length ? 34 + capLines.length * 38 : 0;
    var top = o.amount > 0 ? 212 : 152, H = top + size + quiet * 2 + 150 + capH;
    canvas.width = W; canvas.height = H;
    var g = canvas.getContext('2d'), font = '"Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    g.fillStyle = '#fffdf8'; g.fillRect(0, 0, W, H);
    g.strokeStyle = '#e8d9bf'; g.lineWidth = 4; g.strokeRect(2, 2, W - 4, H - 4);
    g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    function fit(text, y, px, weight, color) {
      var s = px;
      g.fillStyle = color;
      do { g.font = weight + ' ' + s + 'px ' + font; s -= 2; } while (g.measureText(text).width > W - 80 && s > 14);
      g.fillText(text, W / 2, y);
    }
    fit(o.stall, 78, 40, 700, '#3b2314');
    fit('Scan with any UPI app to pay', 118, 24, 500, '#7a6a5d');
    if (o.amount > 0) fit('₹' + new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(o.amount), 192, 64, 700, '#c25e0c');
    var x0 = Math.round((W - size) / 2), y0 = top + quiet;
    g.fillStyle = '#ffffff'; g.fillRect(x0 - quiet, y0 - quiet, size + quiet * 2, size + quiet * 2);
    g.fillStyle = '#262220';
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (qr.isDark(r, c)) g.fillRect(x0 + c * cell, y0 + r * cell, cell, cell);
    var yb = y0 + size + quiet;
    fit('UPI ID: ' + o.upi, yb + 62, 28, 600, '#262220');
    fit('GPay · PhonePe · Paytm · BHIM', yb + 104, 22, 500, '#7a6a5d');
    if (capLines.length) {
      var cy = yb + 104 + 30;
      g.strokeStyle = '#e8d9bf'; g.lineWidth = 2; g.beginPath(); g.moveTo(50, cy); g.lineTo(W - 50, cy); g.stroke();
      g.fillStyle = '#3b2314'; g.font = '500 27px ' + font; g.textAlign = 'center';
      capLines.forEach(function (l, k) { if (l) g.fillText(l, W / 2, cy + 44 + k * 38); });
    }
    return true;
  }
  function canShareFiles() {
    try {
      return !!(navigator.canShare && window.File && navigator.canShare({ files: [new File(['x'], 'x.png', { type: 'image/png' })] }));
    } catch (e) { return false; }
  }
  function reminderMessage(c, amount, lead, plain) {
    var stall = state.stall.name, upi = state.stall.upi_id, L = [];
    L.push('Hello ' + firstName(c.full_name) + ' 🙏');
    if (lead) L.push(lead);
    if (amount > 0) {
      L.push('Your outstanding balance at *' + stall + '* is *' + money(amount) + '* (as on ' + fmtDate(Date.now()) + ').');
      if (upi && plain) { L.push('Scan the QR to pay, or pay to UPI ID ' + upi + '. Thank you!'); }
      else if (upi) { L.push('👉 Tap to pay ' + money(amount) + ' (QR + UPI button):\n' + payPageUrl(upi, stall, amount)); L.push('Or pay to UPI ID *' + upi + '*. Thank you!'); }
      else L.push('Please clear it at your convenience. Thank you!');
    } else {
      L.push('Your khata at *' + stall + '* is fully settled. Thank you! ☕');
    }
    return L.join('\n\n');
  }

  // list: customers (balance rows); opts: { lead, onSent }. With several customers it becomes a step-by-step round.
  function openReminder(list, startAt, opts) {
    opts = opts || {};
    var i = startAt || 0;
    openModal({
      title: 'WhatsApp reminder', size: 'lg', html: '<div id="remBody"></div>',
      onMount: function (b, close) {
        var body = $('#remBody', b);
        function show() {
          var c = list[i], upi = state.stall.upi_id, canShare = canShareFiles(), file = null, dirty = false, sent = false;
          var due = Math.max(round2(Number(c.balance)), 0), last = remindedAt(c.customer_id);
          body.innerHTML =
            (list.length > 1 ? '<div class="rem-progress"><span>Customer ' + (i + 1) + ' of ' + list.length + '</span><div class="bar"><i style="width:' + Math.round((i + 1) / list.length * 100) + '%"></i></div></div>' : '') +
            '<div class="rem-who">' + avatarHTML(c.full_name) + '<div class="rem-name"><b>' + esc(c.full_name) + '</b><div class="muted">' + esc(c.mobile) + (last ? ' · reminded ' + agoText(last) : '') + '</div></div>' +
            '<div class="rem-due ' + balClass(c.balance) + '">' + money(Math.abs(c.balance)) + '<small>' + balLabel(c.balance) + '</small></div></div>' +
            '<div class="field"><label for="remAmt">Amount to request (₹)</label><input id="remAmt" class="input" type="text" inputmode="decimal" autocomplete="off" value="' + (due ? due.toFixed(2) : '') + '" placeholder="0.00"></div>' +
            '<div id="remQrBox" class="qr-box"></div>' +
            '<div class="field"><label for="remMsg">Message (edit if you like)</label><textarea id="remMsg" rows="7"></textarea></div>' +
            '<div class="rem-actions"><button type="button" class="btn wa block hidden" id="remShare2">📤 Send QR + message on WhatsApp</button><a class="btn wa block" id="remWa" target="_blank" rel="noopener" href="#">💬 Open WhatsApp chat with ' + esc(firstName(c.full_name)) + '</a>' +
            '<a class="btn block" id="remShare" target="_blank" rel="noopener" href="#"></a>' +
            '<button type="button" class="btn ghost block" id="remCopy">Copy message</button></div>' +
            '<p class="hint" id="remHint">Tap “Send QR + message”, choose WhatsApp, then pick the customer: the QR picture goes with the message printed under it. (Browsers can’t pick the chat for you. The chat button below sends text with a tappable pay link instead.)</p>' +
            (list.length > 1 ? '<div class="form-actions"><button type="button" class="btn ghost" id="remNext">Skip →</button></div>' : '');
          var amtEl = $('#remAmt', body), msgEl = $('#remMsg', body), qrBox = $('#remQrBox', body), shareBtn = $('#remShare', body), share2 = $('#remShare2', body);
          function curAmount() { var v = amtEl.value.trim(); return v === '' ? 0 : parseAmount(v); }
          function refresh() {
            var amt = curAmount();
            if (isNaN(amt)) { amtEl.setAttribute('aria-invalid', 'true'); return; }
            amtEl.removeAttribute('aria-invalid');
            if (!dirty) msgEl.value = reminderMessage(c, amt, opts.lead);
            syncLinks();
            file = null;
            shareBtn.classList.add('hidden'); share2.classList.add('hidden');
            if (amt > 0 && upi) {
              qrBox.innerHTML = '<canvas id="remQr" role="img" aria-label="UPI payment QR code"></canvas>';
              var cv = $('#remQr', qrBox);
              var ok = drawPayCard(cv, upiLink(upi, state.stall.name, amt, 'Khata dues'), { stall: state.stall.name, amount: amt, upi: upi, caption: reminderMessage(c, amt, opts.lead, true).replace(/\*/g, '').split('\n\n') });
              if (!ok) { qrBox.innerHTML = '<div class="qr-missing">The QR code could not be generated. The UPI ID is still included in the message.</div>'; return; }
              cv.toBlob(function (blob) { if (blob) file = new File([blob], 'pay-' + String(c.full_name).toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.png', { type: 'image/png' }); });
              shareBtn.textContent = '💬 Open chat + get QR image';
              shareBtn.classList.remove('hidden');
              if (canShare) { share2.classList.remove('hidden'); $('#remWa', body).classList.remove('wa'); shareBtn.classList.add('hidden'); }
            } else if (!upi) {
              qrBox.innerHTML = '<div class="qr-missing">Add your UPI ID in <a href="#/settings" data-close>Settings</a> to include a payment QR.</div>';
            } else {
              qrBox.innerHTML = '';
            }
          }
          function waHref() { return 'https://wa.me/91' + c.mobile + '?text=' + encodeURIComponent(msgEl.value.trim()); }
          function syncLinks() { $('#remWa', body).href = waHref(); shareBtn.href = waHref(); }
          function markSent() {
            markReminded(c.customer_id); sent = true;
            if (opts.onSent) opts.onSent();
            var nx = $('#remNext', body);
            if (nx) nx.textContent = i + 1 < list.length ? 'Next customer →' : 'Done';
            nx && nx.classList.add('primary');
          }
          amtEl.oninput = refresh;
          msgEl.oninput = function () { dirty = true; syncLinks(); };
          $('#remWa', body).onclick = function (e) {
            if (!msgEl.value.trim()) { e.preventDefault(); return toast('The message is empty.', 'error'); }
            syncLinks(); markSent();          // the link itself opens WhatsApp
          };
          // Open the customer's chat with the text, and at the same time put the QR picture on the clipboard
          // (paste it in WhatsApp Web/desktop) or save it (attach it from the gallery on a phone).
          shareBtn.onclick = function (e) {
            if (!msgEl.value.trim()) { e.preventDefault(); return toast('The message is empty.', 'error'); }
            syncLinks(); markSent();          // the link itself opens the chat
            if (!file) return;
            var f = file, saved = function () { downloadBlob(f, f.name); toast('Chat opened. QR image saved — tap 📎 in WhatsApp and attach it.', 'success'); };
            try {
              if (navigator.clipboard && window.ClipboardItem && !isTouch()) {
                navigator.clipboard.write([new ClipboardItem({ 'image/png': f })]).then(function () { toast('Chat opened. QR image copied — press Ctrl+V in the chat to paste it.', 'success'); }, saved);
              } else saved();
            } catch (err) { saved(); }
          };
          // Phones: the system share sheet sends the picture (QR + message printed under it) and the text as caption to the chat you pick.
          share2.onclick = function () {
            if (!file) return toast('The QR is still getting ready — try again in a second.', 'error');
            var amt = curAmount(), txt = dirty ? msgEl.value.trim() : reminderMessage(c, amt, opts.lead, true);
            var data = { files: [file], text: txt };
            if (navigator.canShare && !navigator.canShare(data)) { downloadBlob(file, file.name); return toast('Your phone cannot share pictures from the browser, so the QR was saved. Open the chat and attach it.', 'error'); }
            navigator.share(data).then(markSent).catch(function (e) {
              if (e && e.name === 'AbortError') return;
              downloadBlob(file, file.name); toast('Sharing failed, so the QR image was saved. Open the chat and attach it.', 'error');
            });
          };
          $('#remCopy', body).onclick = function () { copyText(msgEl.value).then(function () { toast('Message copied.', 'success'); }, function () { toast('Could not copy.', 'error'); }); };
          var nxt = $('#remNext', body);
          if (nxt) nxt.onclick = function () { if (i + 1 < list.length) { i++; show(); var mdl = b.closest('.modal'); if (mdl) mdl.scrollTop = 0; } else close(); };
          refresh();
        }
        show();
      }
    });
  }

  function openQrPreview() {
    var upi = state.stall.upi_id;
    if (!upi) return toast('Save your UPI ID first.', 'error');
    var file = null;
    openModal({
      title: 'Your payment QR',
      html: '<div class="qr-box"><canvas id="pvQr" role="img" aria-label="UPI payment QR code"></canvas></div><p class="hint">Scan it with your own phone’s UPI app to check it points to the right account. Reminders add the amount automatically.</p><div class="form-actions"><button class="btn" id="pvDl">⬇ Download</button></div>',
      onMount: function (b) {
        var cv = $('#pvQr', b);
        if (!drawPayCard(cv, upiLink(upi, state.stall.name, 0, ''), { stall: state.stall.name, amount: 0, upi: upi })) { $('.qr-box', b).innerHTML = '<div class="qr-missing">The QR library could not load.</div>'; return; }
        cv.toBlob(function (blob) { file = blob; });
        $('#pvDl', b).onclick = function () { if (file) downloadBlob(file, 'payment-qr.png'); };
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* Shell & router                                                      */
  /* ------------------------------------------------------------------ */
  function bnav(n) { return '<a href="#/' + n.id + '" data-nav="' + n.id + '"><span class="ico">' + n.icon + '</span><span class="lbl">' + n.label + '</span></a>'; }

  function renderShell() {
    var owner = isOwner();
    var nav = owner ? OWNER_NAV : CUSTOMER_NAV;
    var bottom = nav.filter(function (n) { return n.bottom; });
    var bottomHTML = owner
      ? bottom.slice(0, 2).map(bnav).join('') +
        '<a href="#/entry" class="fab" data-fab data-nav="entry" aria-label="New entry"><span class="fab-ico">＋</span><span class="lbl">Entry</span></a>' +
        bottom.slice(2).map(bnav).join('') +
        '<button type="button" id="moreBtn"><span class="ico">⋯</span><span class="lbl">More</span></button>'
      : bottom.map(bnav).join('');
    $('#app').innerHTML =
      '<div class="shell ' + (owner ? 'owner' : 'customer') + '">' +
      '<aside class="sidebar"><div class="brand">☕ <span>Chai Khata</span></div><div class="stall-name">' + esc(state.stall.name) + '</div>' +
      '<nav>' + nav.map(function (n) { return '<a href="#/' + n.id + '" class="nav-link" data-nav="' + n.id + '"' + (n.fab ? ' data-fab' : '') + '><span class="ico">' + n.icon + '</span>' + esc(n.title || n.label) + '</a>'; }).join('') + '</nav>' +
      '<div class="side-foot"><div class="who">' + esc(state.profile.full_name) + '<small>' + (owner ? 'Owner' : 'Customer') + '</small></div>' +
      '<button class="btn ghost light" id="logoutSide">Sign out</button></div></aside>' +
      '<div class="main"><header class="topbar"><div class="brand-sm">☕ Chai Khata</div><h1 id="pageTitle"></h1>' +
      (owner ? '<a class="btn primary sm topbar-cta" href="#/entry" data-fab>＋ New entry</a>'
             : '<button class="icon-btn bell" id="bellBtn" title="Notifications" aria-label="Notifications">🔔<span class="bell-badge hidden" id="bellBadge">0</span></button>') +
      '</header><main id="view" class="view" tabindex="-1"></main></div>' +
      '<nav class="bottom-nav' + (owner ? ' has-fab' : '') + '" aria-label="Main">' + bottomHTML + '</nav></div>';
    $('#logoutSide').onclick = signOut;
    if (!owner) { $('#bellBtn').onclick = openNotifications; updateBell(); startNotifications(); }
    var more = $('#moreBtn');
    if (more) more.onclick = function () {
      var rest = OWNER_NAV.filter(function (n) { return !n.bottom && !n.fab; });
      openModal({
        title: 'Menu',
        html: '<div class="tile-grid">' + rest.map(function (n) { return '<a class="tile" href="#/' + n.id + '" data-close><span class="tile-ico">' + n.icon + '</span>' + esc(n.title || n.label) + '</a>'; }).join('') + '</div>' +
          '<p class="muted" style="text-align:center;margin:16px 0 10px">Signed in as <b>' + esc(state.profile.full_name) + '</b> · ' + esc(state.stall.name) + '</p><button class="btn block danger" id="moreOut">Sign out</button>',
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
    dues: { title: 'Dues & Reminders', render: viewDues },
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
    var more = $('#moreBtn');
    if (more) more.classList.toggle('active', !OWNER_NAV.some(function (n) { return (n.bottom || n.fab) && n.id === active; }));
    var v = views[r.name];
    $('#pageTitle').textContent = r.name === 'customers' && r.id ? 'Customer Ledger' : v.title;
    document.title = v.title + ' · Chai Khata';
    var token = ++state.renderToken;
    var alive = function () { return token === state.renderToken; };
    // Fresh container each time so event listeners from a previous page never pile up.
    var old = $('#view'), el = old.cloneNode(false);
    old.parentNode.replaceChild(el, old);
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

  function resetEntry() { entry.customerId = null; entry.cart.clear(); entry.note = ''; entry.done = null; entry.tab = 'purchase'; entry.sigs = {}; entry.ids = {}; }
  function bindGlobalClicks() {
    document.addEventListener('click', function (e) {
      var f = e.target.closest('[data-fab]');
      if (!f) return;
      e.preventDefault();
      resetEntry();
      closeAllModals();
      if (location.hash === '#/entry') route(); else location.hash = '#/entry';
    });
    // Browser back/forward or any navigation closes open dialogs.
    window.addEventListener('hashchange', closeAllModals);
  }

  // Shared handler for the action buttons on customer rows (bill / payment / remind / edit).
  function bindRowActions(root, onChanged) {
    root.addEventListener('click', function (e) {
      var t = e.target.closest('[data-bill],[data-pay],[data-remind],[data-edit]');
      if (!t) return;
      var id = t.getAttribute('data-bill') || t.getAttribute('data-pay') || t.getAttribute('data-remind') || t.getAttribute('data-edit');
      var c = getCustomer(id);
      if (t.hasAttribute('data-bill')) { entry.tab = 'purchase'; location.hash = '#/entry/' + id; }
      else if (t.hasAttribute('data-pay')) { entry.tab = 'payment'; location.hash = '#/entry/' + id; }
      else if (t.hasAttribute('data-remind')) { if (c) openReminder([c], 0, { onSent: onChanged }); }
      else if (t.hasAttribute('data-edit')) { if (c) openCustomerForm(c, onChanged); }
    });
  }

  /* ------------------------------------------------------------------ */
  /* OWNER: Dashboard                                                    */
  /* ------------------------------------------------------------------ */
  function mrowTx(t) {
    var e = Number(t.balance_effect), side = e > 0 ? 'debit' : 'credit';
    return '<a class="mrow' + (t.is_reversed ? ' reversed' : '') + '" href="#/customers/' + t.customer_id + '"><span class="mrow-ico ' + side + '">' + notifIcon(t) + '</span>' +
      '<span class="mrow-main"><b>' + esc(t.customer ? t.customer.full_name : '') + '</b><small>' + esc(txLabel(t)) + ' · ' + fmtDate(t.created_at) + ', ' + fmtTime(t.created_at) + '</small></span>' +
      '<b class="amt ' + side + '">' + (e > 0 ? '+' : '−') + money(Math.abs(e)) + '</b></a>';
  }

  function viewDashboard(el, r, alive) {
    var today = todayISO();
    return Promise.all([
      loadCustomers(),
      q(sb.rpc('report_daily', { p_from: today, p_to: today })),
      q(sb.from('transactions').select(TX_SELECT).order('created_at', { ascending: false }).limit(8))
    ]).then(function (res) {
      if (!alive()) return;
      var customers = res[0], t = res[1][0] || { sales: 0, collections: 0, bills: 0 }, recent = res[2];
      var dues = customers.filter(function (c) { return c.is_active && Number(c.balance) > 0; }).sort(function (a, b) { return b.balance - a.balance; });
      var outstanding = dues.reduce(function (s, c) { return s + Number(c.balance); }, 0);
      function draw() {
        el.innerHTML =
          '<div class="greet"><h2>Namaste, ' + esc(firstName(state.profile.full_name)) + ' 👋</h2><p class="muted">' + fmtDate(Date.now()) + ' · ' + esc(state.stall.name) + '</p></div>' +
          (!state.stall.upi_id ? '<a class="banner warn" href="#/settings">⚙️ Add your UPI ID in Settings so WhatsApp reminders can include a payment QR →</a>' : '') +
          '<div class="stats">' +
          '<div class="stat accent"><div class="label">Today’s sales</div><div class="value">' + money(t.sales) + '</div><div class="sub">' + (t.bills || 0) + ' bill(s)</div></div>' +
          '<div class="stat"><div class="label">Collected today</div><div class="value">' + money(t.collections) + '</div></div>' +
          '<div class="stat"><div class="label">Total outstanding</div><div class="value">' + money(outstanding) + '</div><div class="sub">' + dues.length + ' customer(s)</div></div>' +
          '<div class="stat"><div class="label">Customers</div><div class="value">' + customers.filter(function (c) { return c.is_active; }).length + '</div><div class="sub">active</div></div></div>' +
          '<div class="quick-tiles"><a class="qtile primary" href="#/entry" data-fab><span>＋</span>New entry</a><button class="qtile" id="qAdd"><span>👤</span>Add customer</button><a class="qtile" href="#/dues"><span>💬</span>Send reminders</a></div>' +
          '<div class="two-col"><section class="card"><h2 class="card-title">Needs attention <a class="btn sm ghost" href="#/dues">All dues</a></h2>' +
          (dues.length ? '<div class="mlist">' + dues.slice(0, 5).map(function (c) {
            var ra = remindedAt(c.customer_id);
            return '<div class="mrow">' + avatarHTML(c.full_name) + '<a class="mrow-main" href="#/customers/' + c.customer_id + '"><b>' + esc(c.full_name) + '</b><small>' + (ra ? 'Reminded ' + agoText(ra) : 'Never reminded') + '</small></a>' +
              '<b class="due">' + money(c.balance) + '</b><button class="btn sm wa icon" data-remind="' + c.customer_id + '" aria-label="Remind ' + esc(c.full_name) + ' on WhatsApp">💬</button></div>';
          }).join('') + '</div>' : emptyHTML('🎉', 'No dues', 'All customers are settled up.')) + '</section>' +
          '<section class="card"><h2 class="card-title">Recent activity <a class="btn sm ghost" href="#/transactions">View all</a></h2>' +
          (recent.length ? '<div class="mlist">' + recent.map(mrowTx).join('') + '</div>' : emptyHTML('🧾', 'No transactions yet', 'Record your first purchase to get started.', '<a class="btn primary" href="#/entry" data-fab>New entry</a>')) + '</section></div>';
        $('#qAdd', el).onclick = function () { openCustomerForm(null, function () { loadCustomers().then(function () { if (alive()) route(); }); }); };
      }
      bindRowActions(el, function () { if (alive()) draw(); });
      draw();
    });
  }

  /* ------------------------------------------------------------------ */
  /* OWNER: New entry                                                    */
  /* ------------------------------------------------------------------ */
  function requestIdFor(kind, sig) {
    if (entry.sigs[kind] !== sig || !entry.ids[kind]) { entry.sigs[kind] = sig; entry.ids[kind] = uuid(); }
    return entry.ids[kind];
  }
  function clearRequest(kind) { entry.sigs[kind] = null; entry.ids[kind] = null; }
  function setEntryHash(id) { try { history.replaceState(null, '', id ? '#/entry/' + id : '#/entry'); } catch (e) { /* ignore */ } }

  function comboRows(term) {
    var t = term.trim().toLowerCase(), rec = lsGet(ukey('recent'), []);
    var rows = state.customers.filter(function (c) {
      return c.is_active && (!t || [c.full_name, c.mobile, c.username].some(function (v) { return (v || '').toLowerCase().indexOf(t) !== -1; }));
    });
    function rank(c) { var i = rec.indexOf(c.customer_id); return i < 0 ? 99 : i; }
    rows.sort(function (a, b) {
      if (t) { var sa = a.full_name.toLowerCase().indexOf(t) === 0 ? 0 : 1, sb2 = b.full_name.toLowerCase().indexOf(t) === 0 ? 0 : 1; if (sa !== sb2) return sa - sb2; }
      return rank(a) - rank(b) || a.full_name.localeCompare(b.full_name);
    });
    return rows;
  }

  function viewEntry(el, r, alive) {
    return Promise.all([loadCustomers(), loadProducts()]).then(function () {
      if (!alive()) return;
      if (r.id && getCustomer(r.id)) {
        if (entry.customerId !== r.id) { entry.cart.clear(); entry.note = ''; entry.done = null; }
        entry.customerId = r.id;
      }
      if (entry.customerId && !getCustomer(entry.customerId)) entry.customerId = null;
      if (!entry.method) entry.method = lsGet(ukey('method'), 'Cash');
      var c0 = getCustomer(entry.customerId);
      el.innerHTML = '<div class="entry"><section class="card cust-pick"><div class="combo">' +
        '<span class="combo-ico" aria-hidden="true">🔍</span>' +
        '<input id="custSearch" class="combo-input" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" role="combobox" aria-expanded="false" aria-controls="comboList" aria-label="Customer" placeholder="Search customer by name or mobile…" value="' + esc(c0 ? c0.full_name : '') + '">' +
        '<button type="button" class="combo-clear' + (c0 ? '' : ' hidden') + '" id="comboClear" aria-label="Clear customer">✕</button>' +
        '<ul class="combo-list hidden" id="comboList" role="listbox"></ul></div>' +
        '<div id="recentChips"></div><div id="custSummary"></div></section><div id="entryArea"></div></div>';
      bindCombo(el);
      bindRowActions(el, function () { loadCustomers().then(function () { if (alive()) { renderSummary(); renderEntryArea(); } }); });
      $('#entryArea', el).addEventListener('click', function (e) {
        var tab = e.target.closest('[data-tab]'), pick = e.target.closest('[data-pick]'), add = e.target.closest('[data-addcust]');
        if (tab) { entry.tab = tab.dataset.tab; $$('[data-tab]', el).forEach(function (b) { var on = b.dataset.tab === entry.tab; b.classList.toggle('active', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); }); renderEntryBody(); }
        else if (pick) selectCustomer(pick.dataset.pick);
        else if (add) addCustomerFromEntry('');
      });
      $('#recentChips', el).addEventListener('click', function (e) { var p = e.target.closest('[data-pick]'); if (p) selectCustomer(p.dataset.pick); });
      renderSummary(); renderEntryArea();
      if (!entry.customerId && !isTouch()) $('#custSearch', el).focus();
    });
  }

  function addCustomerFromEntry(typed) {
    var t = String(typed || '').trim(), digits = t.replace(/\D/g, '');
    var prefill = digits.length >= 6 && digits.length === t.replace(/[\s+\-]/g, '').length ? { mobile: digits } : { name: t };
    openCustomerForm(null, function (res) {
      loadCustomers().then(function () { if (res && res.customer_id && getCustomer(res.customer_id)) selectCustomer(res.customer_id); });
    }, prefill);
  }

  function bindCombo(el) {
    var input = $('#custSearch', el), list = $('#comboList', el), clear = $('#comboClear', el);
    var typed = false, active = -1, rows = [], closeT = null;
    function setOpen(open) { list.classList.toggle('hidden', !open); input.setAttribute('aria-expanded', open ? 'true' : 'false'); }
    function restore() { var c = getCustomer(entry.customerId); input.value = c ? c.full_name : ''; typed = false; clear.classList.toggle('hidden', !c); }
    function mark() {
      $$('li[data-id]', list).forEach(function (li, i) { li.classList.toggle('active', i === active); li.setAttribute('aria-selected', i === active ? 'true' : 'false'); if (i === active) li.scrollIntoView({ block: 'nearest' }); });
    }
    function draw() {
      rows = comboRows(typed ? input.value : '').slice(0, 30);
      active = rows.length ? 0 : -1;
      list.innerHTML = rows.length ? rows.map(function (c) {
        return '<li role="option" data-id="' + c.customer_id + '">' + avatarHTML(c.full_name) + '<span class="combo-name"><b>' + esc(c.full_name) + '</b><small>' + esc(c.mobile) + '</small></span><b class="' + balClass(c.balance) + '">' + money(Math.abs(c.balance)) + '</b></li>';
      }).join('') : '<li class="combo-empty">No matching customer.' + (typed && input.value.trim() ? ' <button type="button" class="link-btn" data-add>Add “' + esc(input.value.trim()) + '” as a new customer</button>' : '') + '</li>';
      mark();
    }
    input.addEventListener('focus', function () {
      clearTimeout(closeT);
      typed = false;
      if (entry.customerId) { setTimeout(function () { try { input.select(); } catch (e) { /* ignore */ } }, 0); draw(); setOpen(true); }
    });
    input.addEventListener('input', function () { typed = true; clear.classList.toggle('hidden', !input.value); draw(); setOpen(true); });
    input.addEventListener('keydown', function (e) {
      var open = !list.classList.contains('hidden');
      if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) { draw(); setOpen(true); } else if (active < rows.length - 1) { active++; mark(); } }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (open && active > 0) { active--; mark(); } }
      else if (e.key === 'Enter') { if (open && rows[active]) { e.preventDefault(); selectCustomer(rows[active].customer_id); } }
      else if (e.key === 'Escape') { setOpen(false); restore(); }
    });
    input.addEventListener('blur', function () { closeT = setTimeout(function () { setOpen(false); restore(); }, 180); });
    list.addEventListener('pointerdown', function (e) { e.preventDefault(); });
    list.addEventListener('click', function (e) {
      if (e.target.closest('[data-add]')) { var v = input.value; setOpen(false); addCustomerFromEntry(v); return; }
      var li = e.target.closest('[data-id]'); if (li) selectCustomer(li.dataset.id);
    });
    clear.addEventListener('click', function () {
      entry.customerId = null; entry.done = null; setEntryHash(null);
      input.value = ''; typed = false; clear.classList.add('hidden'); setOpen(false);
      renderSummary(); renderEntryArea(); input.focus();
    });
  }

  function selectCustomer(id) {
    var c = getCustomer(id); if (!c) return;
    if (entry.customerId !== id) entry.done = null;
    entry.customerId = id; pushRecent(id);
    var input = $('#custSearch'), cl = $('#comboClear'), ls = $('#comboList');
    if (input) { input.value = c.full_name; input.blur(); }
    if (cl) cl.classList.remove('hidden');
    if (ls) ls.classList.add('hidden');
    setEntryHash(id); renderSummary(); renderEntryArea();
    window.scrollTo(0, 0);
  }

  function renderSummary() {
    var c = getCustomer(entry.customerId), box = $('#custSummary'), chips = $('#recentChips');
    if (!box || !chips) return;
    if (!c) { box.innerHTML = ''; chips.innerHTML = ''; return; }
    var due = Number(c.balance) > 0;
    box.innerHTML = '<div class="sel-bar">' + avatarHTML(c.full_name) + '<div class="sel-main"><b>' + esc(c.full_name) + '</b><small>' + esc(c.mobile) + (c.last_activity ? ' · last ' + fmtDate(c.last_activity) : '') + '</small></div>' +
      '<div class="sel-bal ' + balClass(c.balance) + '">' + money(Math.abs(c.balance)) + '<small>' + balLabel(c.balance) + '</small></div></div>' +
      '<div class="sel-actions">' + (due ? '<button class="btn sm wa" data-remind="' + c.customer_id + '">💬 Remind</button>' : '') + '<a class="btn sm ghost" href="#/customers/' + c.customer_id + '">📒 Ledger</a>' +
      (c.is_active ? '' : '<span class="badge red">Inactive — cannot be billed</span>') + '</div>';
    var rec = getRecents().filter(function (id) { return id !== c.customer_id; }).slice(0, 6);
    chips.innerHTML = rec.length ? '<div class="chips"><span class="chips-label">Switch to</span>' + rec.map(function (id) {
      var x = getCustomer(id);
      return '<button type="button" class="chip" data-pick="' + id + '">' + esc(firstName(x.full_name)) + (Number(x.balance) > 0 ? ' <small class="due">' + money(x.balance).replace('.00', '') + '</small>' : '') + '</button>';
    }).join('') + '</div>' : '';
  }

  function quickListHTML() {
    if (!state.customers.length) return emptyHTML('👥', 'No customers yet', 'Add your first regular customer to start their khata.', '<button class="btn primary" data-addcust>＋ Add customer</button>');
    var seen = {}, rows = [];
    getRecents().concat(state.customers.filter(function (c) { return c.is_active && Number(c.balance) > 0; }).sort(function (a, b) { return b.balance - a.balance; }).map(function (c) { return c.customer_id; }))
      .concat(state.customers.filter(function (c) { return c.is_active; }).map(function (c) { return c.customer_id; })).forEach(function (id) {
        if (!seen[id] && getCustomer(id) && getCustomer(id).is_active && rows.length < 10) { seen[id] = 1; rows.push(getCustomer(id)); }
      });
    return '<h3 class="sec-title">Tap a customer to start</h3><div class="mlist card-list">' + rows.map(function (c) {
      return '<button type="button" class="mrow tap" data-pick="' + c.customer_id + '">' + avatarHTML(c.full_name) + '<span class="mrow-main"><b>' + esc(c.full_name) + '</b><small>' + esc(c.mobile) + '</small></span><b class="' + balClass(c.balance) + '">' + money(Math.abs(c.balance)) + '</b></button>';
    }).join('') + '</div><p class="hint">Not listed? Type a name or number above, or <button type="button" class="link-btn" data-addcust>add a new customer</button>.</p>';
  }

  function doneHTML(c) {
    var d = entry.done, bal = Number(c.balance);
    return '<section class="card done-card"><div class="done-tick" aria-hidden="true">✓</div><h3>' + esc(d.title) + '</h3><p>' + esc(d.text) + '</p>' +
      '<p class="done-bal">New balance <b class="' + balClass(bal) + '">' + money(Math.abs(bal)) + '</b> <small>' + balLabel(bal) + '</small></p>' +
      '<div class="done-actions"><button type="button" class="btn primary block" id="doneNext">👤 Next customer</button>' +
      '<button type="button" class="btn block" id="doneAgain">＋ Another entry for ' + esc(firstName(c.full_name)) + '</button>' +
      '<button type="button" class="btn wa block" id="doneWa">💬 Send WhatsApp update</button></div></section>';
  }

  function renderEntryArea() {
    var area = $('#entryArea'); if (!area) return;
    var c = getCustomer(entry.customerId);
    if (!c) { area.innerHTML = quickListHTML(); return; }
    if (entry.done) {
      area.innerHTML = doneHTML(c);
      $('#doneNext', area).onclick = function () {
        resetEntry(); setEntryHash(null);
        var inp = $('#custSearch'); if (inp) { inp.value = ''; if (!isTouch()) inp.focus(); }
        var cl = $('#comboClear'); if (cl) cl.classList.add('hidden');
        renderSummary(); renderEntryArea(); window.scrollTo(0, 0);
      };
      $('#doneAgain', area).onclick = function () { entry.done = null; renderEntryArea(); };
      $('#doneWa', area).onclick = function () { openReminder([c], 0, { lead: entry.done.lead }); };
      return;
    }
    area.innerHTML = '<div class="tabs" role="tablist">' + [['purchase', '🧾 Purchase'], ['payment', '💰 Payment'], ['adjustment', '✏️ Adjust']].map(function (t) {
      return '<button type="button" role="tab" data-tab="' + t[0] + '" class="' + (entry.tab === t[0] ? 'active' : '') + '" aria-selected="' + (entry.tab === t[0]) + '">' + t[1] + '</button>';
    }).join('') + '</div><div id="entryBody" class="entry-body"></div>';
    renderEntryBody();
  }

  function renderEntryBody() {
    var body = $('#entryBody'); if (!body) return;
    var c = getCustomer(entry.customerId); if (!c) return;
    if (entry.tab === 'purchase') renderPurchaseForm(body);
    else if (entry.tab === 'payment') renderPaymentForm(body, c);
    else renderAdjustmentForm(body, c);
  }

  function refreshAfterEntry() {
    return loadCustomers().then(function () { renderSummary(); renderEntryArea(); window.scrollTo(0, 0); });
  }

  function cartLines() {
    var lines = [];
    entry.cart.forEach(function (qty, pid) { var p = getProduct(pid); if (p && p.is_active) lines.push({ p: p, qty: qty }); });
    return lines;
  }

  function renderPurchaseForm(body) {
    var prods = state.products.filter(function (p) { return p.is_active; });
    if (!prods.length) { body.innerHTML = emptyHTML('☕', 'No products yet', 'Add tea, snacks and more before recording purchases.', '<a class="btn primary" href="#/products">Add products</a>'); return; }
    var use = lsGet(ukey('produse'), {});
    prods.sort(function (a, b) { return (use[b.id] || 0) - (use[a.id] || 0) || a.name.localeCompare(b.name); });
    body.innerHTML = (prods.length > 8 ? '<div class="field"><input type="search" id="prodFilter" class="input" placeholder="Filter products…" aria-label="Filter products"></div>' : '') +
      '<div class="product-grid" id="prodGrid">' + prods.map(function (p) {
        return '<div class="prod" role="button" tabindex="0" data-pid="' + p.id + '" data-name="' + esc(p.name.toLowerCase()) + '"><span class="prod-name">' + esc(p.name) + '</span><span class="prod-price">' + money(p.price) + ' / ' + esc(p.unit) + '</span><span class="prod-badge"></span><button type="button" class="prod-minus" data-minus aria-label="Remove one ' + esc(p.name) + '">−</button></div>';
      }).join('') + '</div><div id="cartBox"></div><div class="action-bar" id="actionBar"></div>';
    var grid = $('#prodGrid', body);
    function add(pid) { entry.cart.set(pid, round2((entry.cart.get(pid) || 0) + 1)); renderCart(); }
    grid.addEventListener('click', function (e) {
      var tile = e.target.closest('[data-pid]'); if (!tile) return;
      if (e.target.closest('[data-minus]')) {
        var cur = entry.cart.get(tile.dataset.pid) || 0;
        if (cur - 1 <= 0) entry.cart.delete(tile.dataset.pid); else entry.cart.set(tile.dataset.pid, round2(cur - 1));
        renderCart(); return;
      }
      add(tile.dataset.pid);
    });
    grid.addEventListener('keydown', function (e) {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-pid]')) { e.preventDefault(); add(e.target.dataset.pid); }
    });
    var f = $('#prodFilter', body);
    if (f) f.oninput = function () { var t = f.value.trim().toLowerCase(); $$('.prod', grid).forEach(function (n) { n.classList.toggle('hidden', !!t && n.dataset.name.indexOf(t) === -1); }); };
    renderCart();
  }

  function renderCart() {
    var box = $('#cartBox'), bar = $('#actionBar'); if (!box || !bar) return;
    var lines = cartLines();
    var total = lines.reduce(function (s, l) { return s + round2(l.qty * Number(l.p.price)); }, 0);
    var count = lines.reduce(function (s, l) { return s + l.qty; }, 0);
    $$('.prod').forEach(function (b) {
      var q2 = entry.cart.get(b.dataset.pid);
      b.classList.toggle('in-cart', !!q2);
      $('.prod-badge', b).textContent = q2 ? num(q2) : '';
    });
    if (!lines.length) {
      box.innerHTML = '';
      bar.innerHTML = '<div class="ab-info muted">Tap products to build the bill</div><button type="button" class="btn primary" disabled>Record purchase</button>';
      return;
    }
    box.innerHTML = '<div class="cart">' + lines.map(function (l) {
      return '<div class="cart-line" data-line="' + l.p.id + '"><div class="name">' + esc(l.p.name) + '<small class="muted">' + money(l.p.price) + ' each</small></div>' +
        '<div class="qty"><button type="button" data-dec aria-label="Decrease">−</button><input type="number" inputmode="decimal" step="0.5" min="0.5" value="' + num(l.qty) + '" aria-label="Quantity"><button type="button" data-inc aria-label="Increase">+</button></div>' +
        '<div class="line-total"><b>' + money(l.qty * l.p.price) + '</b></div></div>';
    }).join('') + '</div><div class="field" style="margin-top:12px"><label for="entryNote">Note (optional)</label><input id="entryNote" type="text" maxlength="300" value="' + esc(entry.note) + '" placeholder="e.g. for the office group"></div>';
    bar.innerHTML = '<div class="ab-info"><span>' + num(count) + ' item' + (count === 1 ? '' : 's') + '</span><b>' + money(total) + '</b></div><button type="button" class="btn ghost sm" id="cartClear">Clear</button><button type="button" class="btn primary" id="submitPurchase">Record purchase</button>';
    box.onclick = function (e) {
      var line = e.target.closest('[data-line]'); if (!line) return;
      var pid = line.dataset.line, cur = entry.cart.get(pid) || 0;
      if (e.target.closest('[data-inc]')) entry.cart.set(pid, round2(cur + 1));
      else if (e.target.closest('[data-dec]')) { if (cur - 1 <= 0) entry.cart.delete(pid); else entry.cart.set(pid, round2(cur - 1)); }
      else return;
      renderCart();
    };
    box.onchange = function (e) {
      var line = e.target.closest('[data-line]'); if (!line || e.target.type !== 'number') return;
      var v = round2(Number(e.target.value));
      if (!(v > 0)) entry.cart.delete(line.dataset.line);
      else if (v > 1000) toast('Quantity can be at most 1000.', 'error');
      else entry.cart.set(line.dataset.line, v);
      renderCart();
    };
    $('#entryNote').oninput = function (e) { entry.note = e.target.value; };
    $('#cartClear').onclick = function () { entry.cart.clear(); entry.note = ''; renderCart(); };
    $('#submitPurchase').onclick = function (e) { submitPurchase(e.currentTarget); };
  }

  function submitPurchase(btn) {
    var c = getCustomer(entry.customerId); if (!c) return;
    if (!c.is_active) return toast('This customer is inactive. Activate them in Customers first.', 'error');
    var lines = cartLines();
    if (!lines.length) return toast('Add at least one product.', 'error');
    var items = lines.map(function (l) { return { product_id: l.p.id, quantity: l.qty }; });
    var note = entry.note.trim();
    if (note.length > 300) return toast('Note is too long (max 300 characters).', 'error');
    var total = lines.reduce(function (s, l) { return s + round2(l.qty * Number(l.p.price)); }, 0);
    var sum = lines.map(function (l) { return l.p.name + ' ×' + num(l.qty); }).join(', ');
    var rid = requestIdFor('purchase', JSON.stringify([c.customer_id, items, note]));
    return withBusy(btn, function () {
      return q(sb.rpc('record_purchase', { p_customer: c.customer_id, p_items: items, p_note: note || null, p_request_id: rid })).then(function () {
        bumpProducts(items.map(function (i) { return i.product_id; })); pushRecent(c.customer_id);
        entry.cart.clear(); entry.note = ''; clearRequest('purchase');
        entry.done = { title: 'Purchase recorded', text: money(total) + ' · ' + sum, lead: 'A purchase of ' + money(total) + ' (' + sum + ') was added to your khata on ' + nowStamp() + '.' };
        toast('Purchase recorded for ' + c.full_name + '.', 'success');
        return refreshAfterEntry();
      }).catch(function (err) { handleError(err); });
    });
  }

  function renderPaymentForm(body, c) {
    var due = Math.max(round2(Number(c.balance)), 0);
    body.innerHTML = '<form id="payForm" novalidate>' +
      '<div class="field"><label for="payAmt">Amount received (₹)</label><input id="payAmt" class="input big-input" type="text" inputmode="decimal" placeholder="0.00" autocomplete="off"></div>' +
      '<div class="chips quick-amts">' + (due > 0 ? '<button type="button" class="chip strong" data-amt="' + due.toFixed(2) + '">Full due ' + money(due) + '</button>' : '') +
      [50, 100, 200, 500].map(function (a) { return '<button type="button" class="chip" data-amt="' + a + '">₹' + a + '</button>'; }).join('') + '</div>' +
      '<div class="field"><span class="label">Method</span><div class="seg">' + PAY_METHODS.map(function (m) {
        return '<label><input type="radio" name="payMethod" value="' + m + '"' + (entry.method === m ? ' checked' : '') + '><span>' + m + '</span></label>';
      }).join('') + '</div></div>' +
      '<div class="field"><label for="payNote">Note (optional)</label><input id="payNote" type="text" maxlength="300"></div>' +
      '<div class="error-text" id="payErr" role="alert"></div></form>' +
      '<div class="action-bar"><div class="ab-info muted">Payment from ' + esc(firstName(c.full_name)) + '</div><button type="submit" form="payForm" class="btn primary" id="payGo">Record payment</button></div>';
    $$('[data-amt]', body).forEach(function (b) { b.onclick = function () { $('#payAmt', body).value = Number(b.dataset.amt).toFixed(2); }; });
    $$('input[name=payMethod]', body).forEach(function (rb) { rb.onchange = function () { entry.method = rb.value; lsSet(ukey('method'), rb.value); }; });
    $('#payForm', body).onsubmit = function (e) {
      e.preventDefault();
      var err = $('#payErr', body); err.textContent = '';
      var amt = parseAmount($('#payAmt', body).value);
      if (isNaN(amt)) { err.textContent = 'Enter a valid amount (₹0.01 to ₹10,00,000, up to 2 decimals).'; return; }
      var method = $('input[name=payMethod]:checked', body).value, note = $('#payNote', body).value.trim();
      var go = amt > due ? confirmDialog('This is more than the amount due (' + money(due) + '). The customer will be left with an advance of ' + money(amt - due) + '. Continue?', 'Record payment') : Promise.resolve(true);
      go.then(function (ok) {
        if (!ok) return;
        var rid = requestIdFor('payment', JSON.stringify([c.customer_id, amt, method, note]));
        return withBusy($('#payGo', body), function () {
          return q(sb.rpc('record_payment', { p_customer: c.customer_id, p_amount: amt, p_method: method, p_note: note || null, p_request_id: rid })).then(function () {
            clearRequest('payment'); pushRecent(c.customer_id);
            entry.done = { title: 'Payment recorded', text: money(amt) + ' received via ' + method, lead: 'We received your payment of ' + money(amt) + ' (' + method + ') on ' + nowStamp() + '. Thank you!' };
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
      '<div class="error-text" id="adjErr" role="alert"></div></form>' +
      '<div class="action-bar"><div class="ab-info muted">Adjustment for ' + esc(firstName(c.full_name)) + '</div><button type="submit" form="adjForm" class="btn primary" id="adjGo">Record adjustment</button></div>';
    $('#adjForm', body).onsubmit = function (e) {
      e.preventDefault();
      var err = $('#adjErr', body); err.textContent = '';
      var amt = parseAmount($('#adjAmt', body).value), note = $('#adjNote', body).value.trim(), dir = $('#adjDir', body).value;
      if (isNaN(amt)) { err.textContent = 'Enter a valid amount (₹0.01 to ₹10,00,000, up to 2 decimals).'; return; }
      if (note.length < 3) { err.textContent = 'Please give a reason (at least 3 characters).'; return; }
      var rid = requestIdFor('adjustment', JSON.stringify([c.customer_id, dir, amt, note]));
      withBusy($('#adjGo', body), function () {
        return q(sb.rpc('record_adjustment', { p_customer: c.customer_id, p_direction: dir, p_amount: amt, p_note: note, p_request_id: rid })).then(function () {
          clearRequest('adjustment');
          entry.done = { title: 'Adjustment recorded', text: (dir === 'debit' ? 'Charge ' : 'Credit ') + money(amt) + ' · ' + note, lead: 'An adjustment of ' + money(amt) + ' (' + (dir === 'debit' ? 'added' : 'credited') + ': ' + note + ') was recorded on ' + nowStamp() + '.' };
          toast('Adjustment recorded.', 'success'); return refreshAfterEntry();
        }).catch(function (e2) { if (e2.expired) handleError(e2); else err.textContent = e2.message; });
      });
    };
  }

  /* ------------------------------------------------------------------ */
  /* OWNER: Customers                                                    */
  /* ------------------------------------------------------------------ */
  function crowHTML(c, mode) {
    var due = Number(c.balance) > 0, ra = remindedAt(c.customer_id);
    return '<article class="crow' + (mode === 'dues' ? ' dues' : '') + (c.is_active ? '' : ' inactive') + '">' +
      '<a class="crow-main" href="#/customers/' + c.customer_id + '">' + avatarHTML(c.full_name) +
      '<span class="crow-name"><b>' + esc(c.full_name) + '</b><small>' + esc(c.mobile) + (c.username ? ' · @' + esc(c.username) : '') + (c.is_active ? '' : ' · inactive') + '</small></span></a>' +
      '<div class="crow-bal"><b class="' + balClass(c.balance) + '">' + money(Math.abs(c.balance)) + '</b><small>' + balLabel(c.balance) + '</small></div>' +
      '<div class="crow-last">' + (mode === 'dues' ? (ra ? 'Reminded <br>' + agoText(ra) : 'Never <br>reminded') : (c.last_activity ? 'Last activity <br>' + fmtDate(c.last_activity) : 'No activity yet')) + '</div>' +
      '<div class="crow-actions">' +
      (c.is_active ? '<button type="button" class="btn sm" data-bill="' + c.customer_id + '">＋ Bill</button><button type="button" class="btn sm" data-pay="' + c.customer_id + '">₹ Payment</button>' : '') +
      (due && c.is_active ? '<button type="button" class="btn sm wa" data-remind="' + c.customer_id + '">💬 Remind</button>' : '') +
      (mode === 'dues' ? '' : '<button type="button" class="btn sm ghost icon" data-edit="' + c.customer_id + '" aria-label="Edit ' + esc(c.full_name) + '">✎</button>') + '</div></article>';
  }

  function viewCustomers(el, r, alive) {
    if (r.id) return viewCustomerLedger(el, r, alive);
    return loadCustomers().then(function () {
      if (!alive()) return;
      var status = lsGet(ukey('cstatus'), 'active');
      el.innerHTML = '<div class="page-head"><div class="muted" id="custSub"></div><div class="actions"><button type="button" class="btn sm" id="expCust">⬇ CSV</button><button type="button" class="btn primary" id="addCust">＋ Add customer</button></div></div>' +
        '<input type="search" id="custFilter" class="input" placeholder="Search by name, mobile or username…" aria-label="Search customers">' +
        '<div class="chip-tabs" id="custStatus" role="tablist">' + [['active', 'Active'], ['due', 'With dues'], ['all', 'All'], ['inactive', 'Inactive']].map(function (s) {
          return '<button type="button" role="tab" data-st="' + s[0] + '" class="' + (status === s[0] ? 'on' : '') + '">' + s[1] + '</button>';
        }).join('') + '</div><div id="custList"></div>';
      function filtered() {
        var term = $('#custFilter', el).value.trim().toLowerCase();
        return state.customers.filter(function (c) {
          if (status === 'active' && !c.is_active) return false;
          if (status === 'inactive' && c.is_active) return false;
          if (status === 'due' && !(Number(c.balance) > 0)) return false;
          return !term || [c.full_name, c.mobile, c.username].some(function (v) { return (v || '').toLowerCase().indexOf(term) !== -1; });
        });
      }
      function draw() {
        var rows = filtered(), host = $('#custList', el);
        var owed = rows.reduce(function (s, c) { return s + Math.max(Number(c.balance), 0); }, 0);
        $('#custSub', el).textContent = rows.length + ' customer' + (rows.length === 1 ? '' : 's') + (owed > 0 ? ' · ' + money(owed) + ' due' : '');
        if (!rows.length) {
          host.innerHTML = state.customers.length ? emptyHTML('🔍', 'No matching customers', 'Try a different search or filter.') :
            emptyHTML('👥', 'No customers yet', 'Add your first regular customer to start their khata.', '<button class="btn primary" id="addCust2">＋ Add customer</button>');
          var a2 = $('#addCust2', host); if (a2) a2.onclick = function () { openCustomerForm(null, refresh); };
          return;
        }
        host.innerHTML = '<div class="crow-head"><span>Customer</span><span>Balance</span><span>Activity</span><span></span></div><div class="clist">' + rows.map(function (c) { return crowHTML(c); }).join('') + '</div>';
      }
      function refresh() { return loadCustomers().then(function () { if (alive()) draw(); }); }
      $('#custFilter', el).oninput = debounce(draw, 150);
      $('#custStatus', el).addEventListener('click', function (e) {
        var b = e.target.closest('[data-st]'); if (!b) return;
        status = b.dataset.st; lsSet(ukey('cstatus'), status);
        $$('[data-st]', el).forEach(function (x) { x.classList.toggle('on', x === b); });
        draw();
      });
      $('#addCust', el).onclick = function () { openCustomerForm(null, refresh); };
      $('#expCust', el).onclick = function () {
        var rows = filtered();
        if (!rows.length) return toast('No customers to export.', 'error');
        downloadCSV('customers-' + todayISO() + '.csv', ['Name', 'Mobile', 'Username', 'Status', 'Total purchases (Rs)', 'Total payments (Rs)', 'Balance (Rs)', 'Last activity'],
          rows.map(function (c) { return [c.full_name, c.mobile, c.username || '', c.is_active ? 'Active' : 'Inactive', Number(c.total_purchases), Number(c.total_payments), Number(c.balance), c.last_activity ? fmtISODate(istDateOf(c.last_activity)) : '']; }));
      };
      bindRowActions(el, refresh);
      draw();
    });
  }

  /* ---------- Dues & reminders ---------- */
  function viewDues(el, r, alive) {
    return loadCustomers().then(function () {
      if (!alive()) return;
      var sort = lsGet(ukey('dsort'), 'high');
      function dueRows() {
        var rows = state.customers.filter(function (c) { return c.is_active && Number(c.balance) > 0; });
        if (sort === 'name') rows.sort(function (a, b) { return a.full_name.localeCompare(b.full_name); });
        else if (sort === 'quiet') rows.sort(function (a, b) { return String(a.last_activity || '').localeCompare(String(b.last_activity || '')); });
        else rows.sort(function (a, b) { return b.balance - a.balance; });
        return rows;
      }
      function draw() {
        var rows = dueRows(), today = todayISO();
        var total = rows.reduce(function (s, c) { return s + Number(c.balance); }, 0);
        var pending = rows.filter(function (c) { var ra = remindedAt(c.customer_id); return !ra || istDateOf(ra) !== today; });
        el.innerHTML = (!state.stall.upi_id ? '<a class="banner warn" href="#/settings">⚙️ Add your UPI ID in Settings to attach a payment QR to reminders →</a>' : '') +
          '<div class="stats three"><div class="stat accent"><div class="label">Total due</div><div class="value">' + money(total) + '</div></div><div class="stat"><div class="label">Customers</div><div class="value">' + rows.length + '</div></div><div class="stat"><div class="label">Not reminded today</div><div class="value">' + pending.length + '</div></div></div>' +
          (rows.length ? '<div class="toolbar"><button type="button" class="btn wa" id="startRound"' + (pending.length ? '' : ' disabled') + '>💬 Start reminder round (' + pending.length + ')</button>' +
            '<select id="dueSort" class="input" aria-label="Sort"><option value="high">Highest due first</option><option value="quiet">Quiet the longest</option><option value="name">Name A–Z</option></select>' +
            '<button type="button" class="btn sm" id="dueCsv">⬇ CSV</button></div><p class="hint">A round opens each customer’s WhatsApp message one by one — you just press send in WhatsApp.</p>' +
            '<div class="clist">' + rows.map(function (c) { return crowHTML(c, 'dues'); }).join('') + '</div>' : emptyHTML('🎉', 'No dues', 'Every customer is settled up.'));
        var sel = $('#dueSort', el); if (sel) { sel.value = sort; sel.onchange = function () { sort = sel.value; lsSet(ukey('dsort'), sort); draw(); }; }
        var go = $('#startRound', el); if (go) go.onclick = function () { openReminder(pending, 0, { onSent: function () { if (alive()) draw(); } }); };
        var csv = $('#dueCsv', el); if (csv) csv.onclick = function () {
          downloadCSV('dues-' + todayISO() + '.csv', ['Customer', 'Mobile', 'Balance due (Rs)', 'Last activity'], rows.map(function (c) { return [c.full_name, c.mobile, Number(c.balance), c.last_activity ? fmtISODate(istDateOf(c.last_activity)) : '']; }));
        };
      }
      bindRowActions(el, function () { if (alive()) draw(); });
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
        '<div class="form-actions"><button type="button" class="btn" id="copyCred">Copy details</button><a class="btn wa" target="_blank" rel="noopener" href="https://wa.me/91' + esc(c.mobile) + '?text=' + encodeURIComponent(msg) + '">💬 Send on WhatsApp</a></div>',
      onMount: function (b) {
        $('#copyCred', b).onclick = function () { copyText(msg).then(function () { toast('Copied.', 'success'); }, function () { toast('Could not copy.', 'error'); }); };
      }
    });
  }

  function openCustomerForm(c, done, prefill) {
    var editing = !!c; prefill = prefill || {};
    openModal({
      title: editing ? 'Edit customer' : 'Add customer',
      html: '<form id="custForm" novalidate>' +
        '<div class="field"><label for="cfName">Full name</label><input id="cfName" type="text" maxlength="80" required autocomplete="off" value="' + esc(c ? c.full_name : (prefill.name || '')) + '"></div>' +
        '<div class="field"><label for="cfMobile">Mobile number</label><input id="cfMobile" type="tel" inputmode="numeric" maxlength="14" required autocomplete="off" value="' + esc(c ? c.mobile : (prefill.mobile || '')) + '"' + (editing ? ' disabled' : '') + '>' +
        (editing ? '<span class="hint">Mobile number is their login and cannot be changed.</span>' : '') + '</div>' +
        '<div class="field"><label for="cfUser">Username (optional)</label><input id="cfUser" type="text" maxlength="30" autocapitalize="none" autocomplete="off" placeholder="e.g. ramesh.k" value="' + esc(c && c.username ? c.username : '') + '"><span class="hint">3–30 characters: letters, digits, dot or underscore.</span></div>' +
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
        $('#cfName', b).addEventListener('input', preview); $('#cfMobile', b).addEventListener('input', preview); preview();
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
              close(); showCredentials('Customer created', res, 'Share these login details with the customer.'); if (done) done(res);
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
      loadCustomers(),
      fetchAll(function () { return sb.from('transactions').select('*, transaction_items(id,product_name,quantity,unit_price,line_total)').eq('customer_id', r.id).order('created_at', { ascending: true }).order('id'); })
    ]).then(function (res) {
      if (!alive()) return;
      var c = getCustomer(r.id), txs = res[1];
      if (!c) { el.innerHTML = emptyHTML('🔍', 'Customer not found', 'This customer does not exist or you cannot access it.', '<a class="btn" href="#/customers">Back to customers</a>'); return; }
      el.innerHTML = '<div class="page-head cl-head"><div><a href="#/customers">← Customers</a><h2>' + esc(c.full_name) + '</h2><div class="muted">' + esc(c.mobile) + (c.username ? ' · @' + esc(c.username) : '') + (c.is_active ? '' : ' · <span class="badge gray">Inactive</span>') + '</div></div>' +
        '<div class="actions">' + (c.is_active ? '<button type="button" class="btn primary" data-bill="' + c.customer_id + '">＋ Bill</button><button type="button" class="btn" data-pay="' + c.customer_id + '">₹ Payment</button>' : '') +
        (Number(c.balance) > 0 && c.is_active ? '<button type="button" class="btn wa" data-remind="' + c.customer_id + '">💬 Remind</button>' : '') + '<button type="button" class="btn ghost icon" data-edit="' + c.customer_id + '" aria-label="Edit customer">✎</button></div></div>' +
        '<div class="stats three"><div class="stat"><div class="label">Total purchases</div><div class="value">' + money(c.total_purchases) + '</div></div>' +
        '<div class="stat"><div class="label">Total payments</div><div class="value">' + money(c.total_payments) + '</div></div>' +
        '<div class="stat accent"><div class="label">' + balLabel(c.balance) + '</div><div class="value">' + money(Math.abs(c.balance)) + '</div></div></div>' +
        (c.notes ? '<p class="muted">Note: ' + esc(c.notes) + '</p>' : '') + '<div id="ledgerHost"></div>';
      bindRowActions(el, route);
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
      host.innerHTML = '<div class="card" style="padding:0"><div class="table-wrap"><table class="table stack stack-tx"><thead><tr><th>When</th><th>Customer</th><th>Type</th><th>Details</th><th class="num">Amount</th><th></th></tr></thead><tbody>' +
        shown.map(function (t) {
          var e = Number(t.balance_effect);
          return '<tr class="' + (t.is_reversed ? 'reversed' : '') + '"><td data-label="When">' + fmtDate(t.created_at) + ' \u00B7 ' + fmtTime(t.created_at) + '</td>' +
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
        host.innerHTML = '<div class="card" style="padding:0"><div class="table-wrap"><table class="table stack stack-prod"><thead><tr><th>Product</th><th class="num">Price</th><th>Status</th><th>Updated</th><th></th></tr></thead><tbody>' +
          rows.map(function (p) {
            return '<tr><td data-label="Product"><b>' + esc(p.name) + '</b></td><td data-label="Price" class="num">' + money(p.price) + ' <small class="muted">/ ' + esc(p.unit) + '</small></td>' +
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
        '<div class="card" style="padding:0"><div class="table-wrap"><table class="table stack stack-rep"><thead><tr><th>Date</th><th class="num">Bills</th><th class="num">Sales</th><th class="num">Collected</th><th class="num">Cash</th><th class="num">UPI</th><th class="num">Other</th></tr></thead><tbody>' +
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
    el.innerHTML = '<div class="two-col"><section class="card"><h2 class="card-title">Stall &amp; payments</h2><form id="stallForm" novalidate>' +
      '<div class="field"><label for="stName">Stall name</label><input id="stName" type="text" maxlength="80" value="' + esc(state.stall.name) + '"></div>' +
      '<div class="field"><label for="stUpi">UPI ID for payment QR</label><input id="stUpi" type="text" autocapitalize="none" autocomplete="off" spellcheck="false" placeholder="e.g. sharmachai@okhdfc" value="' + esc(state.stall.upi_id || '') + '">' +
      '<span class="hint">Added to WhatsApp reminders as a QR and shown to customers who owe money. Leave empty to switch it off.</span></div>' +
      '<div class="error-text" id="stErr" role="alert"></div><div class="form-actions" style="justify-content:flex-start"><button class="btn primary" type="submit">Save</button><button type="button" class="btn" id="stQr">Preview QR</button></div></form>' +
      '<div class="divider"></div><dl class="kv"><dt>Signed in as</dt><dd>' + esc(state.profile.full_name) + '</dd><dt>Email</dt><dd>' + esc(state.profile.login_email) + '</dd></dl>' +
      '<div class="divider"></div><button type="button" class="btn danger block" id="setOut">Sign out</button></section>' +
      '<section class="card"><h2 class="card-title">Change password</h2>' + passwordFormHTML({ recovery: false }) + '</section></div>';
    $('#stQr', el).onclick = openQrPreview;
    $('#setOut', el).onclick = signOut;
    $('#stallForm', el).onsubmit = function (e) {
      e.preventDefault();
      var name = $('#stName', el).value.trim(), upi = $('#stUpi', el).value.trim().toLowerCase(), err = $('#stErr', el); err.textContent = '';
      if (name.length < 2) { err.textContent = 'Enter a stall name (at least 2 characters).'; return; }
      if (upi && !validUpi(upi)) { err.textContent = 'That does not look like a UPI ID. It should look like name@bank, e.g. sharmachai@okhdfc.'; return; }
      withBusy($('button[type=submit]', e.target), function () {
        return q(sb.from('stalls').update({ name: name, upi_id: upi || null }).eq('id', state.stall.id)).then(function () {
          state.stall.name = name; state.stall.upi_id = upi || null;
          var sn = $('.stall-name'); if (sn) sn.textContent = name;
          toast(upi ? 'Saved. Reminders will now include your payment QR.' : 'Saved.', 'success');
        }).catch(function (e2) {
          if (e2.expired) handleError(e2);
          else err.textContent = /upi_id/i.test(e2.message) ? 'The database needs the latest supabase-setup.sql (it adds the UPI ID column). Run it in the Supabase SQL Editor, then try again.' : e2.message;
        });
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
      var upi = state.stall.upi_id, owed = Number(bal.balance);
      var payCard = owed > 0 && upi
        ? '<section class="card pay-card"><div class="pay-row"><div><b>Pay your dues</b><div class="muted">' + money(owed) + ' to ' + esc(state.stall.name) + '</div></div>' +
          '<a class="btn primary" href="' + esc(upiLink(upi, state.stall.name, owed, 'Khata dues')) + '">Pay with UPI app</a></div>' +
          '<div class="pay-links"><button type="button" class="link-btn" id="showQr">Show QR code</button><span class="muted">UPI ID: <b>' + esc(upi) + '</b> <button type="button" class="link-btn" id="copyUpi">Copy</button></span></div>' +
          '<div id="payQrBox" class="qr-box hidden"><canvas id="payQr" role="img" aria-label="UPI payment QR code"></canvas></div></section>' : '';
      el.innerHTML = notifBannerHTML() + '<div class="hero"><div class="label">Hello, ' + esc(firstName(state.profile.full_name)) + ' 👋 — ' + (owed > 0 ? 'Outstanding balance' : owed < 0 ? 'Advance with stall' : 'You are all settled') + '</div>' +
        '<div class="big">' + money(Math.abs(bal.balance)) + '</div><div class="sub">at ' + esc(state.stall.name) + '</div></div>' + payCard +
        '<div class="stats"><div class="stat"><div class="label">Total purchases</div><div class="value">' + money(bal.total_purchases) + '</div></div><div class="stat"><div class="label">Total payments</div><div class="value">' + money(bal.total_payments) + '</div></div></div>' +
        '<h2 class="card-title" style="margin-top:6px">Recent activity <a class="btn sm ghost" href="#/ledger">Full ledger</a></h2>' +
        (recent.length ? '<div class="ledger">' + recent.map(function (t) { return ledgerCardHTML(t, false); }).join('') + '</div>' : emptyHTML('☕', 'Nothing here yet', 'Your purchases and payments will appear here.'));
      var banner = $('#notifBanner', el);
      if (banner) banner.onclick = openNotifications;
      var sq = $('#showQr', el);
      if (sq) sq.onclick = function () {
        var box = $('#payQrBox', el), open = box.classList.toggle('hidden');
        sq.textContent = open ? 'Show QR code' : 'Hide QR code';
        if (!open && !box.dataset.drawn) { box.dataset.drawn = '1'; if (!drawPayCard($('#payQr', el), upiLink(upi, state.stall.name, owed, 'Khata dues'), { stall: state.stall.name, amount: owed, upi: upi })) box.innerHTML = '<div class="qr-missing">The QR could not be drawn. Use the UPI ID above.</div>'; }
      };
      var cu = $('#copyUpi', el);
      if (cu) cu.onclick = function () { copyText(upi).then(function () { toast('UPI ID copied.', 'success'); }, function () { toast('Could not copy.', 'error'); }); };
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
    bindGlobalClicks();

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
