import {
  getSettings, saveSettings, listReceipts, getReceipt, getScreenshot, updateReceipt,
  deleteReceipts, isExcluded, hostOf, receiptTitle, toMarkdown, toPlainText, toHtmlEmail
} from './lib/common.js';

const SCRIPT_ID = 'fs-capture';
const ALL_URLS = { origins: ['<all_urls>'] };

// ---------- Automatic-capture registration ----------

async function syncRegistration() {
  const settings = await getSettings();
  const granted = await chrome.permissions.contains(ALL_URLS);
  const registered = (await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] })).length > 0;
  const want = settings.autoCapture && granted;

  if (settings.autoCapture && !granted) await saveSettings({ autoCapture: false });
  if (want && !registered) {
    await chrome.scripting.registerContentScripts([{
      id: SCRIPT_ID,
      js: ['content/capture.js'],
      matches: ['<all_urls>'],
      allFrames: true,
      runAt: 'document_idle',
      persistAcrossSessions: true
    }]);
    await injectIntoOpenTabs();
  } else if (!want && registered) {
    await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
  }
}

// So pages that were already open start working without a reload.
async function injectIntoOpenTabs() {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  await Promise.all(tabs.map(t => chrome.scripting.executeScript({
    target: { tabId: t.id, allFrames: true },
    files: ['content/capture.js']
  }).catch(() => {})));
}

async function purgeExpired() {
  const { retentionDays } = await getSettings();
  if (!retentionDays) return;
  const cutoff = Date.now() - retentionDays * 86400000;
  const old = (await listReceipts()).filter(r => r.createdAt < cutoff && !r.pinned).map(r => r.id);
  if (old.length) await deleteReceipts(old);
}

chrome.runtime.onInstalled.addListener(async details => {
  if (details.reason === 'install') {
    await chrome.storage.local.set({ settings: await getSettings() });
    chrome.tabs.create({ url: chrome.runtime.getURL('vault/vault.html#welcome') });
  }
  await syncRegistration();
});
chrome.runtime.onStartup.addListener(() => { syncRegistration(); purgeExpired(); });
// The popup may close while Chrome shows the permission prompt, so it leaves a
// flag behind and the grant is completed here.
chrome.permissions.onAdded.addListener(async () => {
  const { pendingAutoCapture } = await chrome.storage.local.get('pendingAutoCapture');
  if (pendingAutoCapture && await chrome.permissions.contains(ALL_URLS)) {
    await chrome.storage.local.remove('pendingAutoCapture');
    await saveSettings({ autoCapture: true });
  }
  await syncRegistration();
});
chrome.permissions.onRemoved.addListener(syncRegistration);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) syncRegistration();
});

// ---------- Saving receipts ----------

// Serialise writes so concurrent captures don't clobber the receipts array.
let queue = Promise.resolve();
const serial = fn => (queue = queue.then(fn, fn));

async function captureScreenshot(tab) {
  if (!tab || !tab.active) return null;
  try {
    return await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 55 });
  } catch {
    return null;
  }
}

async function saveReceipt(page, { tab, trigger, wantShot }) {
  // Take the screenshot first: an automatic capture races the page navigation.
  const shot = wantShot ? await captureScreenshot(tab) : null;
  const receipt = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    url: page.url,
    host: hostOf(page.url),
    title: page.title || '',
    formTitle: page.formTitle || '',
    fields: page.fields,
    trigger,
    hasScreenshot: !!shot,
    note: '',
    pinned: false
  };
  await serial(async () => {
    const receipts = await listReceipts();
    receipts.unshift(receipt);
    const data = { receipts };
    if (shot) data['shot:' + receipt.id] = shot;
    await chrome.storage.local.set(data);
  });
  flashBadge(tab);
  deliver(receipt.id).catch(() => {});
  return receipt;
}

function flashBadge(tab) {
  if (!tab) return;
  chrome.action.setBadgeBackgroundColor({ color: '#2e9d5b', tabId: tab.id }).catch(() => {});
  chrome.action.setBadgeText({ text: '✓', tabId: tab.id }).catch(() => {});
  setTimeout(() => chrome.action.setBadgeText({ text: '', tabId: tab.id }).catch(() => {}), 2500);
}

// Manual capture of a tab: works through activeTab, no host permission needed.
async function scanTab(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content/capture.js'] });
  const res = await chrome.tabs.sendMessage(tabId, { type: 'fs:scan' });
  if (!res || !res.ok) throw new Error((res && res.error) || 'Could not read this page');
  return res.page;
}

async function captureTabNow(tab) {
  const settings = await getSettings();
  const page = await scanTab(tab.id);
  if (!page.fields.length) return { saved: false, reason: 'No filled-in fields found on this page.' };
  const receipt = await saveReceipt(page, { tab, trigger: 'manual', wantShot: settings.screenshot });
  return { saved: true, id: receipt.id, count: receipt.fields.length };
}

// ---------- Delivery: webhook or email via Resend ----------

async function deliver(id, { force = false } = {}) {
  const settings = await getSettings();
  const d = settings.delivery;
  if (d.mode === 'none') return { ok: false, error: 'Delivery is turned off.' };
  const receipt = await getReceipt(id);
  if (!receipt) return { ok: false, error: 'Receipt not found.' };
  if (!force && receipt.delivery && receipt.delivery.status === 'sent') return { ok: true };
  const shot = receipt.hasScreenshot ? await getScreenshot(id) : null;

  let result;
  try {
    if (d.mode === 'webhook') {
      if (!d.webhookUrl) throw new Error('No webhook URL configured.');
      const res = await fetch(d.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'form-safe', receipt, markdown: toMarkdown(receipt), screenshot: shot })
      });
      if (!res.ok) throw new Error(`Webhook answered HTTP ${res.status}`);
    } else if (d.mode === 'resend') {
      if (!d.resendApiKey || !d.resendFrom || !d.emailTo) throw new Error('Resend API key, From and To are required.');
      const body = {
        from: d.resendFrom,
        to: d.emailTo.split(/[,;\s]+/).filter(Boolean),
        subject: `[Form receipt] ${receiptTitle(receipt)} — ${receipt.host}`,
        html: toHtmlEmail(receipt),
        text: toPlainText(receipt)
      };
      if (shot) body.attachments = [{ filename: 'screenshot.jpg', content: shot.split(',')[1] }];
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + d.resendApiKey },
        body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error(`Resend answered HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    result = { ok: true };
    await updateReceipt(id, { delivery: { status: 'sent', mode: d.mode, at: Date.now() } });
  } catch (e) {
    result = { ok: false, error: e.message };
    await updateReceipt(id, { delivery: { status: 'failed', mode: d.mode, at: Date.now(), error: e.message } });
  }
  return result;
}

// ---------- Messages ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handlers = {
    // Automatic capture from the registered content script.
    'fs:capture': async () => {
      const settings = await getSettings();
      const page = msg.payload;
      if (!settings.autoCapture) return { saved: false };
      if (isExcluded(page.url, settings.excludedSites)) return { saved: false };
      if (page.fields.length < settings.minFields) return { saved: false };
      const receipt = await saveReceipt(page, { tab: sender.tab, trigger: page.trigger, wantShot: settings.screenshot });
      return { saved: true, id: receipt.id, showToast: settings.showToast };
    },
    'fs:capture-tab': async () => captureTabNow(await chrome.tabs.get(msg.tabId)),
    'fs:delete': async () => { await deleteReceipts([msg.id]); return { ok: true }; },
    'fs:open': async () => {
      await chrome.tabs.create({ url: chrome.runtime.getURL('vault/vault.html#' + (msg.id || '')) });
      return { ok: true };
    },
    'fs:deliver': () => deliver(msg.id, { force: true })
  };
  const handler = handlers[msg && msg.type];
  if (!handler) return false;
  handler().then(sendResponse, e => sendResponse({ ok: false, saved: false, error: e.message }));
  return true;
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'capture-now') return;
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try { await captureTabNow(tab); } catch { /* restricted page */ }
});
