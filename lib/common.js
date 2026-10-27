// Shared helpers for the service worker, popup and vault pages.

export const DEFAULT_SETTINGS = {
  autoCapture: false,      // needs the optional <all_urls> host permission
  screenshot: true,        // attach a visible-area screenshot when possible
  showToast: true,         // in-page "saved" toast after an automatic capture
  minFields: 2,            // ignore automatic captures with fewer filled fields (search boxes, logins)
  // Hostnames where automatic capture is off. Defaults are mail and chat apps,
  // where every "Send" click would otherwise become a receipt.
  excludedSites: [
    'mail.google.com', 'outlook.live.com', 'outlook.office.com', 'outlook.office365.com',
    'web.whatsapp.com', 'web.telegram.org', 'discord.com', 'app.slack.com', 'teams.microsoft.com',
    'chatgpt.com', 'claude.ai', 'gemini.google.com', 'x.com', 'messenger.com'
  ],
  retentionDays: 0,        // 0 = keep forever
  delivery: {
    mode: 'none',          // 'none' | 'webhook' | 'resend'
    webhookUrl: '',
    resendApiKey: '',
    resendFrom: '',
    emailTo: ''
  }
};

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return {
    ...DEFAULT_SETTINGS,
    ...(settings || {}),
    delivery: { ...DEFAULT_SETTINGS.delivery, ...((settings && settings.delivery) || {}) }
  };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = {
    ...current,
    ...patch,
    delivery: { ...current.delivery, ...((patch && patch.delivery) || {}) }
  };
  await chrome.storage.local.set({ settings: next });
  return next;
}

// Must be called straight from a click handler (permission prompts need a user gesture).
export function requestAutoCapture() {
  const request = chrome.permissions.request({ origins: ['<all_urls>'] });
  chrome.storage.local.set({ pendingAutoCapture: true });
  return request.then(async granted => {
    await chrome.storage.local.remove('pendingAutoCapture');
    if (granted) await saveSettings({ autoCapture: true });
    return granted;
  });
}

// Receipts live under `receipts` (metadata + fields); screenshots are stored
// separately under `shot:<id>` so listing the vault stays cheap.
export async function listReceipts() {
  const { receipts } = await chrome.storage.local.get('receipts');
  return receipts || [];
}

export async function getReceipt(id) {
  return (await listReceipts()).find(r => r.id === id) || null;
}

export async function getScreenshot(id) {
  const key = 'shot:' + id;
  const data = await chrome.storage.local.get(key);
  return data[key] || null;
}

export async function updateReceipt(id, patch) {
  const receipts = await listReceipts();
  const i = receipts.findIndex(r => r.id === id);
  if (i < 0) return null;
  receipts[i] = { ...receipts[i], ...patch };
  await chrome.storage.local.set({ receipts });
  return receipts[i];
}

export async function deleteReceipts(ids) {
  const set = new Set(ids);
  const receipts = (await listReceipts()).filter(r => !set.has(r.id));
  await chrome.storage.local.set({ receipts });
  await chrome.storage.local.remove(ids.map(id => 'shot:' + id));
}

export function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

export function isExcluded(url, excludedSites) {
  const host = hostOf(url);
  if (!host) return true;
  return (excludedSites || []).some(s => {
    const site = s.trim().toLowerCase();
    return site && (host === site || host.endsWith('.' + site));
  });
}

export function formatTime(ts) {
  return new Date(ts).toLocaleString();
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function receiptTitle(r) {
  return r.formTitle || r.title || hostOf(r.url) || 'Untitled form';
}

export function toMarkdown(r) {
  const lines = [
    `# Form receipt — ${receiptTitle(r)}`,
    '',
    `- **Page:** ${r.title || ''}`,
    `- **URL:** ${r.url}`,
    `- **Saved:** ${formatTime(r.createdAt)}`,
    `- **Trigger:** ${r.trigger}`,
    ''
  ];
  let group = null;
  for (const f of r.fields) {
    if (f.group && f.group !== group) {
      group = f.group;
      lines.push(`## ${group}`, '');
    }
    const value = String(f.value).includes('\n')
      ? '\n\n  ' + String(f.value).split('\n').join('\n  ')
      : ' ' + f.value;
    lines.push(`- **${f.label}:**${value}`);
  }
  if (r.note) lines.push('', '## Note', '', r.note);
  return lines.join('\n') + '\n';
}

export function toPlainText(r) {
  return toMarkdown(r).replace(/\*\*/g, '').replace(/^#+ /gm, '');
}

export function toHtmlEmail(r) {
  const rows = r.fields.map(f =>
    `<tr><td style="padding:6px 10px;border:1px solid #ddd;background:#f7f7f9;font-weight:600;vertical-align:top">${escapeHtml(f.label)}</td>` +
    `<td style="padding:6px 10px;border:1px solid #ddd;white-space:pre-wrap">${escapeHtml(f.value)}</td></tr>`
  ).join('');
  return `<div style="font-family:system-ui,sans-serif;font-size:14px;color:#222">
<h2 style="margin:0 0 8px">Form receipt — ${escapeHtml(receiptTitle(r))}</h2>
<p style="margin:0 0 12px;color:#555">${escapeHtml(formatTime(r.createdAt))} · <a href="${escapeHtml(r.url)}">${escapeHtml(r.url)}</a></p>
<table style="border-collapse:collapse">${rows}</table>
<p style="color:#888;font-size:12px;margin-top:16px">Saved by Form Safe. This is your personal copy, not proof the site accepted the submission.</p>
</div>`;
}

export function downloadText(filename, text, mime = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type: mime + ';charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function safeFilename(s) {
  return String(s).replace(/[\\/:*?"<>|\s]+/g, '-').replace(/-+/g, '-').slice(0, 60) || 'receipt';
}
