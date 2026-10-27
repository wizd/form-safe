import {
  getSettings, saveSettings, listReceipts, hostOf, isExcluded, receiptTitle, formatTime,
  escapeHtml, requestAutoCapture
} from '../lib/common.js';

const $ = id => document.getElementById(id);
let tab;

function openVault(hash = '') {
  chrome.tabs.create({ url: chrome.runtime.getURL('vault/vault.html' + (hash ? '#' + hash : '')) });
  window.close();
}

async function render() {
  const settings = await getSettings();
  const host = hostOf(tab && tab.url);
  const webPage = /^https?:/.test((tab && tab.url) || '');

  $('site').textContent = webPage ? host : 'This page can’t be captured';
  $('captureBtn').disabled = !webPage;
  $('autoToggle').checked = settings.autoCapture;

  const excluded = webPage && isExcluded(tab.url, settings.excludedSites);
  $('siteToggle').checked = excluded;
  $('siteRow').classList.toggle('disabled', !settings.autoCapture || !webPage);
  $('siteHint').textContent = excluded ? 'Automatic receipts are paused here' : 'Skip automatic receipts here';

  const recent = (await listReceipts()).slice(0, 5);
  $('recent').innerHTML = recent.length
    ? recent.map(r => `<li data-id="${r.id}"><div class="t">${escapeHtml(receiptTitle(r))}</div>
        <div class="m">${escapeHtml(r.host)} · ${r.fields.length} fields · ${escapeHtml(formatTime(r.createdAt))}</div></li>`).join('')
    : '<li class="empty">No receipts yet.</li>';
}

$('openVault').addEventListener('click', e => { e.preventDefault(); openVault(); });

$('recent').addEventListener('click', e => {
  const li = e.target.closest('li[data-id]');
  if (li) openVault(li.dataset.id);
});

$('captureBtn').addEventListener('click', async () => {
  const msg = $('captureMsg');
  $('captureBtn').disabled = true;
  const res = await chrome.runtime.sendMessage({ type: 'fs:capture-tab', tabId: tab.id });
  $('captureBtn').disabled = false;
  msg.hidden = false;
  if (res && res.saved) {
    msg.className = 'msg';
    msg.textContent = `Saved ${res.count} field${res.count === 1 ? '' : 's'} to your vault.`;
    render();
  } else {
    msg.className = 'msg err';
    msg.textContent = (res && (res.reason || res.error)) || 'Nothing was saved.';
  }
});

$('autoToggle').addEventListener('change', async e => {
  if (e.target.checked) {
    const granted = await requestAutoCapture();
    if (!granted) e.target.checked = false;
  } else {
    await saveSettings({ autoCapture: false });
  }
  render();
});

$('siteToggle').addEventListener('change', async e => {
  const host = hostOf(tab.url);
  const { excludedSites } = await getSettings();
  const next = e.target.checked
    ? [...new Set([...excludedSites, host])]
    : excludedSites.filter(s => !(host === s || host.endsWith('.' + s)));
  await saveSettings({ excludedSites: next });
  render();
});

(async () => {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  render();
})();
