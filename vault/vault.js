import {
  getSettings, saveSettings, listReceipts, getScreenshot, updateReceipt, deleteReceipts,
  receiptTitle, formatTime, escapeHtml, toMarkdown, toPlainText, downloadText, safeFilename,
  requestAutoCapture
} from '../lib/common.js';

const $ = id => document.getElementById(id);
let receipts = [];
let query = '';

// ---------- List ----------

function matches(r, q) {
  if (!q) return true;
  const hay = [r.title, r.formTitle, r.url, r.note, ...r.fields.flatMap(f => [f.label, f.value, f.group])]
    .join('\n').toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every(w => hay.includes(w));
}

function preview(r, q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const f = (words.length && r.fields.find(f => words.some(w => (f.label + ' ' + f.value).toLowerCase().includes(w)))) || r.fields[0];
  return f ? `${f.label}: ${f.value}` : '';
}

function renderList() {
  const shown = receipts.filter(r => matches(r, query));
  const current = currentId();
  $('count').textContent = query
    ? `${shown.length} of ${receipts.length} receipts`
    : `${receipts.length} receipt${receipts.length === 1 ? '' : 's'}`;
  $('list').innerHTML = shown.length
    ? shown.map(r => `<li data-id="${r.id}" class="${r.id === current ? 'active' : ''}">
        <div class="t">${r.pinned ? '📌 ' : ''}${escapeHtml(receiptTitle(r))}</div>
        <div class="m">${escapeHtml(r.host)} · ${escapeHtml(formatTime(r.createdAt))}</div>
        <div class="p">${escapeHtml(preview(r, query))}</div></li>`).join('')
    : `<li class="empty">${receipts.length ? 'No receipts match your search.' : 'No receipts yet.<br>Submit a form or click the toolbar icon.'}</li>`;
}

$('list').addEventListener('click', e => {
  const li = e.target.closest('li[data-id]');
  if (li) location.hash = li.dataset.id;
});

$('search').addEventListener('input', e => { query = e.target.value.trim(); renderList(); });

// ---------- Routing ----------

const currentId = () => {
  const h = decodeURIComponent(location.hash.slice(1));
  return h && h !== 'settings' && h !== 'welcome' ? h : null;
};

function route() {
  const h = location.hash.slice(1);
  renderList();
  if (h === 'settings') return renderSettings();
  if (h === 'welcome' || (!h && !receipts.length)) return renderWelcome();
  if (!h) {
    history.replaceState(null, '', '#' + receipts[0].id);
    return route();
  }
  const r = receipts.find(x => x.id === currentId());
  if (r) return renderDetail(r);
  $('main').innerHTML = '<p class="placeholder">Select a receipt on the left.</p>';
}

window.addEventListener('hashchange', route);

// ---------- Receipt detail ----------

async function renderDetail(r) {
  const settings = await getSettings();
  let group = null;
  const rows = r.fields.map((f, i) => {
    let head = '';
    if (f.group && f.group !== group) {
      group = f.group;
      head = `<tr class="g"><td colspan="3">${escapeHtml(group)}</td></tr>`;
    }
    return head + `<tr><td class="l">${escapeHtml(f.label)}</td><td class="v">${escapeHtml(f.value)}</td>
      <td class="c"><button class="copy" data-i="${i}" title="Copy answer">⧉</button></td></tr>`;
  }).join('');

  const d = r.delivery;
  const delivery = d
    ? `<span class="badge ${d.status === 'sent' ? 'ok' : 'bad'}" title="${escapeHtml(d.error || '')}">${d.status === 'sent' ? 'Sent' : 'Delivery failed'} · ${escapeHtml(d.mode)}</span>`
    : '';

  $('main').innerHTML = `
    <section class="panel">
      <h2>${escapeHtml(receiptTitle(r))}</h2>
      <div class="meta">
        <span>${escapeHtml(formatTime(r.createdAt))}</span>
        <span><a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">${escapeHtml(r.url)}</a></span>
        <span class="badge">${escapeHtml(r.trigger)}</span> ${delivery}
      </div>
      <div class="actions">
        <button id="aCopy">Copy as Markdown</button>
        <button id="aMd">Download .md</button>
        <button id="aMail">Email to myself</button>
        ${settings.delivery.mode !== 'none' ? '<button id="aSend">Send now</button>' : ''}
        <button id="aPrint">Print / PDF</button>
        <button id="aPin">${r.pinned ? 'Unpin' : 'Pin'}</button>
        <button id="aDelete" class="danger">Delete</button>
        <span id="actionMsg" class="msg"></span>
      </div>
      <table class="fields">${rows}</table>
      <h3>Note</h3>
      <div class="note-wrap"><textarea id="note" class="note" rows="2" placeholder="Confirmation number, who you spoke to, follow-up date…">${escapeHtml(r.note || '')}</textarea></div>
      <div id="shotWrap"></div>
    </section>`;

  const say = (text, err) => { const m = $('actionMsg'); m.textContent = text; m.className = 'msg' + (err ? ' err' : ''); };

  if (r.hasScreenshot) {
    const shot = await getScreenshot(r.id);
    if (shot) {
      $('shotWrap').innerHTML = `<h3>Screenshot</h3><img class="shot" alt="Page screenshot" src="${shot}">`;
      $('shotWrap').querySelector('img').addEventListener('click', () => {
        const w = window.open();
        if (w) w.document.write(`<img src="${shot}" style="max-width:100%">`);
      });
    }
  }

  $('main').querySelector('table').addEventListener('click', async e => {
    const b = e.target.closest('.copy');
    if (!b) return;
    await navigator.clipboard.writeText(r.fields[+b.dataset.i].value);
    say('Copied.');
  });
  $('aCopy').onclick = async () => { await navigator.clipboard.writeText(toMarkdown(r)); say('Markdown copied.'); };
  $('aMd').onclick = () => downloadText(`${safeFilename(receiptTitle(r))}-${new Date(r.createdAt).toISOString().slice(0, 10)}.md`, toMarkdown(r), 'text/markdown');
  $('aMail').onclick = () => {
    let body = toPlainText(r);
    if (body.length > 1800) body = body.slice(0, 1800) + '\n… (truncated — use Download .md for the full receipt)';
    location.href = `mailto:${encodeURIComponent(settings.delivery.emailTo || '')}?subject=${encodeURIComponent('[Form receipt] ' + receiptTitle(r))}&body=${encodeURIComponent(body)}`;
  };
  if ($('aSend')) $('aSend').onclick = async () => {
    say('Sending…');
    const res = await chrome.runtime.sendMessage({ type: 'fs:deliver', id: r.id });
    say(res && res.ok ? 'Sent.' : 'Failed: ' + ((res && res.error) || 'unknown error'), !(res && res.ok));
  };
  $('aPrint').onclick = () => window.print();
  $('aPin').onclick = () => updateReceipt(r.id, { pinned: !r.pinned });
  $('aDelete').onclick = async () => {
    if (!confirm('Delete this receipt?')) return;
    const i = receipts.findIndex(x => x.id === r.id);
    const next = receipts[i + 1] || receipts[i - 1];
    await deleteReceipts([r.id]);
    location.hash = next ? next.id : '';
  };
  $('note').addEventListener('change', e => updateReceipt(r.id, { note: e.target.value }));
}

// ---------- Welcome ----------

function renderWelcome() {
  $('main').replaceChildren($('welcomeTpl').content.cloneNode(true));
  getSettings().then(s => {
    if (s.autoCapture) {
      $('welcomeAuto').textContent = '✓ Automatic receipts are on';
      $('welcomeAuto').disabled = true;
    }
  });
  $('welcomeAuto').onclick = async () => {
    if (await requestAutoCapture()) route();
  };
}

// ---------- Settings ----------

async function renderSettings() {
  $('main').replaceChildren($('settingsTpl').content.cloneNode(true));
  const s = await getSettings();
  $('sAuto').checked = s.autoCapture;
  $('sShot').checked = s.screenshot;
  $('sToast').checked = s.showToast;
  $('sMin').value = s.minFields;
  $('sRetention').value = s.retentionDays;
  $('sExcluded').value = s.excludedSites.join('\n');
  $('dMode').value = s.delivery.mode;
  $('dKey').value = s.delivery.resendApiKey;
  $('dFrom').value = s.delivery.resendFrom;
  $('dTo').value = s.delivery.emailTo;
  $('dHook').value = s.delivery.webhookUrl;

  const syncBoxes = () => {
    $('resendBox').hidden = $('dMode').value !== 'resend';
    $('webhookBox').hidden = $('dMode').value !== 'webhook';
  };
  syncBoxes();
  $('dMode').onchange = syncBoxes;

  $('sAuto').onchange = async e => {
    if (e.target.checked) {
      if (!(await requestAutoCapture())) e.target.checked = false;
    } else {
      await saveSettings({ autoCapture: false });
    }
  };

  $('saveSettings').onclick = () => {
    const msg = $('settingsMsg');
    const mode = $('dMode').value;
    // Delivery targets need host permission; ask now, inside the click.
    let origin = null;
    try {
      if (mode === 'resend') origin = 'https://api.resend.com/*';
      if (mode === 'webhook' && $('dHook').value.trim()) origin = new URL($('dHook').value.trim()).origin + '/*';
    } catch {
      msg.textContent = 'The webhook URL is not valid.';
      msg.className = 'msg err';
      return;
    }
    const permission = origin ? chrome.permissions.request({ origins: [origin] }) : Promise.resolve(true);

    permission.then(async granted => {
      await saveSettings({
        screenshot: $('sShot').checked,
        showToast: $('sToast').checked,
        minFields: Math.max(1, parseInt($('sMin').value, 10) || 1),
        retentionDays: Math.max(0, parseInt($('sRetention').value, 10) || 0),
        excludedSites: $('sExcluded').value.split(/[\s,]+/).map(x => x.trim().toLowerCase()).filter(Boolean),
        delivery: {
          mode: granted ? mode : 'none',
          resendApiKey: $('dKey').value.trim(),
          resendFrom: $('dFrom').value.trim(),
          emailTo: $('dTo').value.trim(),
          webhookUrl: $('dHook').value.trim()
        }
      });
      msg.textContent = granted ? 'Saved.' : 'Saved, but delivery stays off: Chrome permission was not granted.';
      msg.className = 'msg' + (granted ? '' : ' err');
      if (!granted) $('dMode').value = 'none';
    });
  };

  $('deleteAll').onclick = async () => {
    if (!confirm(`Delete all ${receipts.length} receipts? This cannot be undone.`)) return;
    await deleteReceipts(receipts.map(r => r.id));
  };
}

// ---------- Export / import ----------

$('exportJson').onclick = async () => {
  const all = await Promise.all(receipts.map(async r => ({
    ...r, screenshot: r.hasScreenshot ? await getScreenshot(r.id) : null
  })));
  downloadText(`form-safe-backup-${new Date().toISOString().slice(0, 10)}.json`,
    JSON.stringify({ app: 'form-safe', version: 1, exportedAt: Date.now(), receipts: all }, null, 2), 'application/json');
};

$('exportCsv').onclick = () => {
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['receipt_id', 'saved_at', 'site', 'url', 'form', 'section', 'question', 'answer'].join(',')];
  for (const r of receipts) {
    for (const f of r.fields) {
      lines.push([r.id, new Date(r.createdAt).toISOString(), r.host, r.url, receiptTitle(r), f.group || '', f.label, f.value].map(esc).join(','));
    }
  }
  // BOM so Excel opens UTF-8 correctly
  downloadText(`form-safe-${new Date().toISOString().slice(0, 10)}.csv`, '\ufeff' + lines.join('\r\n'), 'text/csv');
};

$('importBtn').onclick = () => $('importFile').click();
$('importFile').onchange = async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || !Array.isArray(data.receipts)) throw new Error('Not a Form Safe backup file.');
    const existing = await listReceipts();
    const known = new Set(existing.map(r => r.id));
    const toStore = {};
    let added = 0;
    for (const r of data.receipts) {
      if (!r.id || !Array.isArray(r.fields) || known.has(r.id)) continue;
      const { screenshot, ...rest } = r;
      existing.push({ ...rest, hasScreenshot: !!screenshot });
      if (screenshot) toStore['shot:' + r.id] = screenshot;
      added++;
    }
    existing.sort((a, b) => b.createdAt - a.createdAt);
    await chrome.storage.local.set({ ...toStore, receipts: existing });
    alert(`Imported ${added} receipt${added === 1 ? '' : 's'}.`);
  } catch (err) {
    alert('Import failed: ' + err.message);
  }
};

// ---------- Live updates ----------

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.receipts) return;
  receipts = changes.receipts.newValue || [];
  // Don't rebuild the detail view under someone typing a note.
  if (document.activeElement && document.activeElement.id === 'note') return renderList();
  route();
});

(async () => {
  receipts = await listReceipts();
  route();
})();
