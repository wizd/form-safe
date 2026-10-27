// Form Safe content script.
// Injected on demand (popup / shortcut, via activeTab) or registered on all
// pages when the user turns on automatic capture. Wrapped so a second
// injection into the same frame is a no-op.
(() => {
  if (window.__formSafeLoaded) return;
  window.__formSafeLoaded = true;

  const MAX_VALUE = 5000;
  const FIELD_SELECTOR = [
    'input', 'textarea', 'select',
    '[contenteditable=""]', '[contenteditable="true"]', '[contenteditable="plaintext-only"]',
    '[role="textbox"]', '[role="radio"]', '[role="checkbox"]', '[role="switch"]', '[role="listbox"]'
  ].join(',');
  const SKIP_INPUT_TYPES = new Set(['password', 'hidden', 'submit', 'button', 'reset', 'image']);
  const SENSITIVE_RE = /pass(word|wd|code|phrase)?\b|passwd|pwd|cvv|cvc|csc|card.?(num|no\b|number)|cc.?num|credit.?card|security.?code|\botp\b|one.?time|verification.?code|auth.?code|\bpin\b|ssn|social.?security|iban|routing.?(num|no)|account.?(num|no\b|number)|csrf|xsrf|token|captcha|secret/i;
  const SENSITIVE_AUTOCOMPLETE_RE = /cc-|one-time-code|current-password|new-password/i;
  const SUBMIT_TEXT_RE = /submit|send|apply|continue|confirm|save|register|sign ?up|book|reserve|request|post|complete|finish|done|place order|checkout|enquire|inquire|contact|subscribe|提交|发送|發送|申请|申請|确认|確認|确定|保存|注册|註冊|预约|預約|报名|報名|送信|登録|完了|申し込|신청|제출|전송/i;
  const NOT_SUBMIT_RE = /search|cancel|back|close|log ?in|sign ?in|previous|prev\b|reset|clear|delete|remove|搜索|搜尋|取消|返回|关闭|登录|登入|削除|検索|キャンセル/i;
  const LANDMARK_SELECTOR = 'form,[role="form"],[role="dialog"],dialog,fieldset,section,article,main';

  // ---------- DOM helpers ----------

  // Open shadow roots in the light DOM, refreshed once per collection pass.
  let shadowHosts = [];
  function refreshShadowHosts() {
    shadowHosts = Array.from(document.querySelectorAll('*')).filter(el => el.shadowRoot);
  }

  // querySelectorAll that also walks open shadow roots (web-component forms).
  function deepQueryAll(root, selector) {
    const out = Array.from(root.querySelectorAll(selector));
    const walkShadow = sr => {
      sr.querySelectorAll(selector).forEach(el => out.push(el));
      sr.querySelectorAll('*').forEach(el => { if (el.shadowRoot) walkShadow(el.shadowRoot); });
    };
    for (const host of shadowHosts) {
      if (host !== root && root.contains(host)) walkShadow(host.shadowRoot);
    }
    return out;
  }

  function clean(s, max = 120) {
    s = String(s || '').replace(/\s+/g, ' ').trim().replace(/\s*[*:：]+\s*$/, '').replace(/^\*\s*/, '');
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }

  function isVisible(el) {
    if (!el.isConnected) return false;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    return el.getClientRects().length > 0;
  }

  // Visible text of a live node without the text that belongs to form controls
  // inside it. Block-level elements start a new line, like innerText.
  const OWN_TEXT_SKIP = 'input,select,textarea,option,script,style,noscript,button,[contenteditable],[role="listbox"],[role="textbox"],[role="option"],[aria-hidden="true"]';
  function ownText(node) {
    const parts = [];
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.nodeType === 1) {
          if (n !== node && n.matches(OWN_TEXT_SKIP)) return NodeFilter.FILTER_REJECT;
          if (getComputedStyle(n).display === 'none') return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let n;
    while ((n = walker.nextNode())) {
      if (n.nodeType === 3) parts.push(n.nodeValue);
      else if (!/^inline/.test(getComputedStyle(n).display)) parts.push('\n');
    }
    return parts.join('');
  }

  function firstLine(text) {
    return clean((String(text).split(/\n/).map(s => s.trim()).find(Boolean)) || '');
  }

  function humanize(name) {
    if (!name) return '';
    const s = String(name)
      .replace(/^.*\[(.+)\]$/, '$1')          // user[first_name] -> first_name
      .replace(/^entry\.\d+.*$/, '')          // Google Forms internal names
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/[_\-.]+/g, ' ')
      .trim();
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
  }

  function textOfIds(ids) {
    return ids.split(/\s+/).map(id => document.getElementById(id))
      .filter(Boolean).map(n => n.innerText || n.textContent).join(' ');
  }

  function looksLikeCardNumber(v) {
    const d = String(v).replace(/[\s-]/g, '');
    if (!/^\d{13,19}$/.test(d)) return false;
    let sum = 0;
    for (let i = 0; i < d.length; i++) {
      let n = +d[d.length - 1 - i];
      if (i % 2) { n *= 2; if (n > 9) n -= 9; }
      sum += n;
    }
    return sum % 10 === 0;
  }

  function isFieldLike(el) {
    if (el.tagName === 'INPUT') return !SKIP_INPUT_TYPES.has((el.type || 'text').toLowerCase());
    return true;
  }

  // Count of capturable controls inside a node (used to find question containers).
  function fieldCount(node) {
    return deepQueryAll(node, FIELD_SELECTOR).filter(isFieldLike).length;
  }

  // Walk up from a control while the ancestor contains no other controls and
  // use the first line of its own text as the label (Google Forms, Typeform,
  // most div-soup React forms).
  function containerLabel(el, groupSize = 1) {
    let node = el.parentElement;
    for (let depth = 0; node && depth < 6 && node !== document.body; depth++, node = node.parentElement) {
      if (fieldCount(node) > groupSize) break;
      const t = firstLine(ownText(node));
      if (t) return t;
    }
    // Previous sibling text, e.g. <span>Email</span><input>
    let prev = el.previousElementSibling;
    if (prev && !prev.matches(FIELD_SELECTOR)) {
      const t = firstLine(ownText(prev));
      if (t) return t;
    }
    return '';
  }

  function sensitiveByAttributes(el, label) {
    const ac = el.getAttribute('autocomplete') || '';
    if (SENSITIVE_AUTOCOMPLETE_RE.test(ac)) return true;
    const hay = [el.name, el.id, ac, el.getAttribute('aria-label'), el.placeholder, label].filter(Boolean).join(' ');
    return SENSITIVE_RE.test(hay);
  }

  function labelFor(el) {
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) { const t = clean(textOfIds(labelledby)); if (t) return t; }
    if (el.labels && el.labels.length) {
      const t = clean(ownText(el.labels[0]));
      if (t) return t;
    }
    const aria = clean(el.getAttribute('aria-label'));
    if (aria) return aria;
    const near = containerLabel(el);
    if (near) return near;
    return clean(el.placeholder) || clean(el.title) || humanize(el.name || el.id) || 'Field';
  }

  // Label for a radio / checkbox group (native or ARIA).
  function groupLabel(members) {
    const first = members[0];
    const fieldset = first.closest('fieldset');
    if (fieldset) {
      const legend = fieldset.querySelector('legend');
      if (legend) { const t = clean(legend.innerText); if (t) return t; }
    }
    const group = first.closest('[role="radiogroup"],[role="group"],[role="list"]');
    if (group) {
      const lb = group.getAttribute('aria-labelledby');
      if (lb) { const t = clean(textOfIds(lb)); if (t) return t; }
      const al = clean(group.getAttribute('aria-label'));
      if (al) return al;
    }
    // Climb to the smallest ancestor holding the whole group, then use its
    // text minus the option labels.
    let node = first.parentElement;
    while (node && node !== document.body && !members.every(m => node.contains(m))) node = node.parentElement;
    const optionTexts = new Set(members.map(m => optionText(m)).filter(Boolean));
    for (let depth = 0; node && depth < 5 && node !== document.body; depth++, node = node.parentElement) {
      if (fieldCount(node) > members.length) break;
      const lines = ownText(node).split('\n').map(s => clean(s)).filter(s => s && !optionTexts.has(s));
      if (lines.length) return lines[0];
    }
    return humanize(first.name) || 'Choice';
  }

  function optionText(el) {
    if (el.getAttribute('role')) {
      return clean(el.getAttribute('aria-label') || el.getAttribute('data-value') || el.innerText);
    }
    if (el.labels && el.labels.length) { const t = clean(ownText(el.labels[0])); if (t) return t; }
    const al = clean(el.getAttribute('aria-label'));
    if (al) return al;
    const next = el.nextSibling;
    const t = next && clean(next.textContent);
    return t || clean(el.value);
  }

  // ---------- Field collection ----------

  // Returns [{label, value, type}] for the controls inside `scope`, in document order.
  function collectFields(scope) {
    refreshShadowHosts();
    const els = deepQueryAll(scope, FIELD_SELECTOR);
    const fields = [];
    const doneGroups = new Set();

    for (const el of els) {
      const role = el.getAttribute('role');
      const tag = el.tagName;
      const type = tag === 'INPUT' ? (el.type || 'text').toLowerCase() : (role || tag.toLowerCase());

      if (tag === 'INPUT' && SKIP_INPUT_TYPES.has(type)) continue;
      if (el.disabled) continue;
      // ARIA widgets wrapping a native control are handled through the native one.
      if (role && el.querySelector('input,select,textarea')) continue;
      // contenteditable nested in another contenteditable: only take the outermost.
      if ((el.isContentEditable || role === 'textbox') && el.parentElement && el.parentElement.closest('[contenteditable=""],[contenteditable="true"],[role="textbox"]')) continue;

      if (type === 'radio' || type === 'checkbox' || role === 'radio' || role === 'checkbox' || role === 'switch') {
        const isAria = !!role;
        const groupRoot = isAria
          ? el.closest('[role="radiogroup"],[role="group"],[role="list"]')
          : null;
        const key = isAria
          ? (groupRoot || el)
          : (el.name
            ? `${type}:${Array.prototype.indexOf.call(document.forms, el.form)}:${el.name}`
            : el);
        if (doneGroups.has(key)) continue;
        doneGroups.add(key);

        let members;
        if (isAria) {
          members = groupRoot
            ? Array.from(groupRoot.querySelectorAll('[role="radio"],[role="checkbox"],[role="switch"]'))
            : [el];
        } else if (el.name) {
          const root = el.form || scope;
          members = Array.from(root.querySelectorAll('input[type="' + type + '"]'))
            .filter(m => m.name === el.name);
        } else {
          members = [el];
        }
        const checked = members.filter(m => isAria ? m.getAttribute('aria-checked') === 'true' : m.checked);
        if (!checked.length) continue;
        const visibleish = members.some(m => isVisible(m) || (m.labels && m.labels[0] && isVisible(m.labels[0])) || (m.parentElement && isVisible(m.parentElement)));
        if (!visibleish) continue;

        let label, value;
        if (members.length === 1 && (type === 'checkbox' || role === 'checkbox' || role === 'switch')) {
          // A lone checkbox, e.g. "I agree to the terms"
          label = optionText(el) || labelFor(el);
          value = 'Yes';
        } else {
          label = groupLabel(members);
          value = checked.map(optionText).filter(Boolean).join(', ');
        }
        if (sensitiveByAttributes(el, label)) continue;
        fields.push({ label, value, type: (role || type) === 'radio' ? 'choice' : 'checkbox' });
        continue;
      }

      if (!isVisible(el) && type !== 'file') continue;

      let value;
      if (tag === 'SELECT') {
        value = Array.from(el.selectedOptions).map(o => clean(o.text, 500)).filter(Boolean).join(', ');
        // Ignore untouched placeholder options like "Select…"
        if (el.selectedIndex === 0 && el.options[0] && el.options[0].value === '') value = '';
      } else if (role === 'listbox') {
        value = Array.from(el.querySelectorAll('[role="option"][aria-selected="true"]'))
          .map(o => clean(o.getAttribute('data-value') || o.innerText, 500)).filter(Boolean).join(', ');
      } else if (type === 'file') {
        value = Array.from(el.files || []).map(f => `${f.name} (${Math.ceil(f.size / 1024)} KB)`).join(', ');
      } else if (tag === 'INPUT' || tag === 'TEXTAREA') {
        value = el.value;
      } else {
        value = el.innerText;
      }
      value = String(value || '').replace(/\u00a0/g, ' ').trim();
      if (!value) continue;

      const label = labelFor(el);
      if (sensitiveByAttributes(el, label) || looksLikeCardNumber(value)) continue;
      if (value.length > MAX_VALUE) value = value.slice(0, MAX_VALUE) + '…';
      fields.push({ label, value, type: tag === 'TEXTAREA' || el.isContentEditable ? 'text' : type });
    }
    return fields;
  }

  function formTitleOf(scope) {
    if (scope && scope !== document.body && scope.getAttribute) {
      const al = clean(scope.getAttribute('aria-label'));
      if (al) return al;
      const lb = scope.getAttribute('aria-labelledby');
      if (lb) { const t = clean(textOfIds(lb)); if (t) return t; }
      const h = scope.querySelector('h1,h2,h3,h4,[role="heading"]');
      if (h) { const t = clean(h.innerText); if (t) return t; }
      // Nearest heading above the form, e.g. <section><h2>Title</h2><form>…
      let node = scope.parentElement;
      for (let depth = 0; node && depth < 4 && node !== document.body; depth++, node = node.parentElement) {
        const before = Array.from(node.querySelectorAll('h1,h2,h3,h4,[role="heading"]'))
          .filter(x => x.compareDocumentPosition(scope) & Node.DOCUMENT_POSITION_FOLLOWING);
        const last = before[before.length - 1];
        if (last) { const t = clean(last.innerText); if (t) return t; }
      }
    }
    const h1 = document.querySelector('h1,[role="heading"][aria-level="1"]');
    return clean((h1 && h1.innerText) || document.title);
  }

  // Everything on the page, grouped per form. Used for manual captures.
  function scanPage() {
    const forms = Array.from(document.forms).filter(isVisible);
    const fields = [];
    const multiple = forms.length > 1;
    forms.forEach((form, i) => {
      const group = multiple ? (formTitleOf(form) || 'Form ' + (i + 1)) : '';
      collectFields(form).forEach(f => fields.push({ ...f, group }));
    });
    // Controls outside any <form> (SPA forms)
    const loose = collectFields(document.body).filter(f => !fields.some(x => x.label === f.label && x.value === f.value));
    loose.forEach(f => fields.push({ ...f, group: forms.length ? 'Other fields on page' : '' }));
    return {
      url: location.href,
      title: document.title,
      formTitle: forms.length === 1 ? formTitleOf(forms[0]) : formTitleOf(document.body),
      fields
    };
  }

  // ---------- Automatic capture on submit ----------

  let lastSignature = '';
  let lastTime = 0;

  function scopeForButton(btn) {
    if (btn.form) return btn.form;
    refreshShadowHosts();
    let node = btn.parentElement;
    let best = null;
    while (node && node !== document.documentElement) {
      if (node === document.body) return best || node;
      if (fieldCount(node) > 0) {
        best = node;
        if (node.matches(LANDMARK_SELECTOR)) return node;
      }
      node = node.parentElement;
    }
    return best || document.body;
  }

  function onSubmitIntent(scope, trigger) {
    let fields;
    try { fields = collectFields(scope); } catch (e) { return; }
    if (!fields.length) return;
    const signature = location.href + '|' + JSON.stringify(fields);
    const now = Date.now();
    if (signature === lastSignature && now - lastTime < 5000) return;
    lastSignature = signature;
    lastTime = now;
    const payload = { url: location.href, title: document.title, formTitle: formTitleOf(scope), fields, trigger };
    try {
      chrome.runtime.sendMessage({ type: 'fs:capture', payload }, res => {
        if (chrome.runtime.lastError || !res) return;
        if (res.saved && res.showToast) showToast(res.id, fields.length);
      });
    } catch (e) {
      // Extension was reloaded; this orphaned script can no longer talk to it.
    }
  }

  function buttonText(btn) {
    return clean(btn.innerText || btn.value || btn.getAttribute('aria-label') || btn.title || '');
  }

  document.addEventListener('submit', e => {
    const form = e.composedPath ? e.composedPath()[0] : e.target;
    if (form && form.tagName === 'FORM') onSubmitIntent(form, 'submit');
  }, true);

  document.addEventListener('click', e => {
    const target = e.composedPath ? e.composedPath()[0] : e.target;
    if (!target || !target.closest) return;
    const btn = target.closest('button,input[type="submit"],input[type="button"],[role="button"]');
    if (!btn || btn.disabled || btn.getAttribute('aria-disabled') === 'true') return;
    const isNativeSubmit = (btn.tagName === 'BUTTON' && (btn.type || 'submit') === 'submit') ||
      (btn.tagName === 'INPUT' && btn.type === 'submit');
    // Native submit buttons in a real <form> are covered by the submit event.
    if (isNativeSubmit && btn.form) return;
    const text = buttonText(btn);
    if (!text || NOT_SUBMIT_RE.test(text) || !SUBMIT_TEXT_RE.test(text)) return;
    onSubmitIntent(scopeForButton(btn), 'click: ' + text.slice(0, 40));
  }, true);

  // ---------- In-page toast ----------

  function showToast(id, count) {
    const host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;right:16px;bottom:16px;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        .t{font:13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;background:#1f2430;color:#fff;border-radius:10px;
           padding:10px 12px;box-shadow:0 6px 24px rgba(0,0,0,.25);display:flex;gap:10px;align-items:center;
           animation:in .18s ease-out}
        @keyframes in{from{transform:translateY(8px);opacity:0}}
        b{color:#7ee2a8;font-weight:600}
        button{all:unset;cursor:pointer;color:#9cc4ff;font-weight:600;padding:2px 4px;border-radius:4px}
        button:hover{background:rgba(255,255,255,.1)}
      </style>
      <div class="t">🛡️ <span><b>Form Safe</b> saved ${count} field${count === 1 ? '' : 's'}</span>
        <button data-a="view">View</button><button data-a="undo">Undo</button></div>`;
    root.addEventListener('click', e => {
      const a = e.target.getAttribute && e.target.getAttribute('data-a');
      if (!a) return;
      try { chrome.runtime.sendMessage({ type: a === 'view' ? 'fs:open' : 'fs:delete', id }); } catch (_) {}
      host.remove();
    });
    (document.body || document.documentElement).appendChild(host);
    setTimeout(() => host.remove(), 7000);
  }

  // ---------- Messages from the extension ----------

  try {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg && msg.type === 'fs:scan') {
        try { sendResponse({ ok: true, page: scanPage() }); }
        catch (e) { sendResponse({ ok: false, error: String(e) }); }
      }
    });
  } catch (_) { /* test harness without chrome.runtime */ }

  // Exposed for tests and debugging.
  window.__formSafe = { collectFields, scanPage, labelFor, formTitleOf };
})();
