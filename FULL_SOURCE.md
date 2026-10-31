# ShotToAI 1.1 — complete source

## shottoai/manifest.json

```json
{
  "manifest_version": 3,
  "name": "ShotToAI",
  "version": "1.1.0",
  "description": "Capture a tab, window, or screen and attach a PNG to your AI chat without sending it.",
  "minimum_chrome_version": "116",
  "permissions": ["desktopCapture", "scripting", "tabs", "storage", "clipboardWrite"],
  "optional_permissions": ["downloads"],
  "host_permissions": ["https://chatgpt.com/*", "https://claude.ai/*", "https://gemini.google.com/*"],
  "background": {"service_worker": "background.js", "type": "module"},
  "action": {"default_title": "ShotToAI — capture screenshot"},
  "commands": {
    "capture": {
      "suggested_key": {"default": "Ctrl+Shift+S", "mac": "MacCtrl+Shift+S"},
      "description": "Capture and attach a screenshot"
    }
  },
  "options_page": "options.html",
  "content_scripts": [{
    "matches": ["https://chatgpt.com/*", "https://claude.ai/*", "https://gemini.google.com/*"],
    "js": ["page-capture.js", "content.js"],
    "run_at": "document_idle"
  }]
}
```

## shottoai/background.js

```javascript
import {SITES, settings, supported, delay} from "./shared.js";

let starting = false;
let picker = null;
chrome.action.onClicked.addListener(tab => start(tab));
chrome.commands.onCommand.addListener(async command => {
  if (command === "capture") start((await chrome.tabs.query({active: true, lastFocusedWindow: true}))[0]);
});
async function pageMessage(tabId, message) {
  try {
    const status = await chrome.tabs.sendMessage(tabId, {type: "SHOT_PING"}, {frameId: 0});
    if (status?.version !== 2) throw new Error("Old content script");
  } catch {
    await chrome.scripting.executeScript({target: {tabId}, files: ["page-capture.js", "content.js"]});
  }
  return chrome.tabs.sendMessage(tabId, message, {frameId: 0});
}
function choose(tab) {
  return new Promise((resolve, reject) => {
    // Bind the short-lived token to the tab where the content script consumes it.
    // No popup or extension capture tab is created.
    const requestId = chrome.desktopCapture.chooseDesktopMedia(["tab", "window", "screen"], tab, streamId => {
      picker = null;
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(streamId);
    });
    picker = {tabId: tab.id, url: tab.url, cancel() {
      chrome.desktopCapture.cancelChooseDesktopMedia(requestId);
      picker = null;
      resolve("");
    }};
  });
}
async function start(origin) {
  if (starting) return;
  starting = true;
  let job;
  try {
    // A crop overlay can survive worker suspension. Check before starting another job.
    const stored = (await chrome.storage.session.get("job")).job;
    if (stored) {
      const state = await chrome.tabs.sendMessage(stored.targetId, {type: "SHOT_PING"}, {frameId: 0}).catch(() => null);
      if (state?.jobId === stored.id) {
        await pageMessage(stored.targetId, {type: "SHOT_TOAST", text: "Finish or cancel the current screenshot first."});
        return;
      }
    }
    const s = await settings();
    const candidates = (await chrome.tabs.query({})).filter(t => supported(t.url));
    let target = supported(origin?.url) ? origin : candidates.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
    // Only open the configured default when there are no existing AI tabs at all.
    if (!target) target = await chrome.tabs.create({url: SITES[s.defaultSite], active: true});
    if (target.id !== origin?.id) {
      await chrome.windows.update(target.windowId, {focused: true});
      await chrome.tabs.update(target.id, {active: true});
    }
    for (let i = 0; i < 60; i++) {
      target = await chrome.tabs.get(target.id);
      if (target.status === "complete") break;
      await delay(250);
    }
    if (!supported(target.url)) throw new Error("Open a supported AI chat and sign in before capturing.");
    job = {id: crypto.randomUUID(), targetId: target.id, targetUrl: target.url, settings: s};
    await chrome.storage.session.set({job});
    const prepared = await pageMessage(target.id, {type: "SHOT_PREPARE", jobId: job.id, targetUrl: job.targetUrl});
    if (!prepared?.ok) throw new Error(prepared?.error || "Reload this AI tab, then try ShotToAI again.");
    const streamId = await choose(target);
    if (!streamId) {
      await pageMessage(target.id, {type: "SHOT_TOAST", text: "Screenshot capture cancelled."});
      return;
    }
    const current = await chrome.tabs.get(target.id);
    if (current.url !== job.targetUrl) throw new Error("The chat navigated during capture. Try again in the intended chat.");
    const result = await chrome.tabs.sendMessage(target.id, {type: "SHOT_CAPTURE", streamId,
      jobId: job.id, targetUrl: job.targetUrl, settings: s}, {frameId: 0});
    if (result?.error) throw new Error(result.error);
    await chrome.action.setBadgeText({text: ""});
    await chrome.action.setTitle({title: "ShotToAI — capture screenshot"});
  } catch (error) {
    console.warn("ShotToAI:", error.message);
    await chrome.action.setBadgeText({text: "!"});
    await chrome.action.setTitle({title: `ShotToAI: ${error.message}`});
    if (job) await pageMessage(job.targetId, {type: "SHOT_TOAST", text: error.message}).catch(() => {});
  } finally {
    if (job) {
      await chrome.tabs.sendMessage(job.targetId, {type: "SHOT_RELEASE", jobId: job.id}, {frameId: 0}).catch(() => {});
      const stored = (await chrome.storage.session.get("job")).job;
      if (stored?.id === job.id) await chrome.storage.session.remove("job");
    }
    starting = false;
  }
}
chrome.tabs.onRemoved.addListener(tabId => { if (picker?.tabId === tabId) picker.cancel(); });
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (picker?.tabId === tabId && (change.status === "loading" || (change.url && change.url !== picker.url))) picker.cancel();
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!["SHOT_HEARTBEAT", "SHOT_FOCUS", "SHOT_SAVE"].includes(message.type)) return;
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || !supported(sender.url)) return;
  (async () => {
    const {job} = await chrome.storage.session.get("job");
    if (!job || job.id !== message.jobId || job.targetId !== sender.tab?.id || job.targetUrl !== sender.url)
      throw new Error("Capture expired or the chat navigated. Start a new capture.");
    if (message.type === "SHOT_HEARTBEAT") return {ok: true};
    if (message.type === "SHOT_FOCUS") {
      const tab = await chrome.tabs.get(job.targetId);
      await chrome.windows.update(tab.windowId, {focused: true});
      await chrome.tabs.update(tab.id, {active: true});
      return {ok: true};
    }
    if (!job.settings.save || !await chrome.permissions.contains({permissions: ["downloads"]}))
      throw new Error("Enable Downloads in Options first.");
    if (!message.dataUrl?.startsWith("data:image/png;base64,") || message.dataUrl.length > 32_000_000)
      throw new Error("Invalid or oversized PNG.");
    const filename = String(message.filename).replace(/[^a-zA-Z0-9_.-]/g, "_");
    await chrome.downloads.download({url: message.dataUrl, filename: `ShotToAI/${filename}`, saveAs: false});
    return {ok: true};
  })().then(respond, error => respond({error: error.message}));
  return true;
});
```

## shottoai/shared.js

```javascript
export const SITES = {
  "chatgpt.com": "https://chatgpt.com/",
  "claude.ai": "https://claude.ai/new",
  "gemini.google.com": "https://gemini.google.com/app"
};
export const DEFAULTS = {
  defaultSite: "chatgpt.com", copy: false, save: false, crop: false, maxWidth: 1920
};
export function supported(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && Object.hasOwn(SITES, u.hostname);
  } catch { return false; }
}
export async function settings() {
  const s = await chrome.storage.local.get(DEFAULTS);
  return {...s, defaultSite: Object.hasOwn(SITES, s.defaultSite) ? s.defaultSite : DEFAULTS.defaultSite,
    maxWidth: Math.max(320, Math.min(7680, Number(s.maxWidth) || 1920))};
}
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export function pngData(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
```

## shottoai/content.js

```javascript
(() => {
  // Update these selectors when a site's composer or attachment UI changes.
  const ADAPTERS = {
    "chatgpt.com": {
      composer: ['#prompt-textarea', '[contenteditable="true"][data-lexical-editor="true"]', 'textarea[placeholder*="Message"]', '[contenteditable="true"][role="textbox"]'],
      inputs: ['input[type="file"][accept*="image"]', 'input[type="file"][multiple]', 'input[type="file"]'],
      scope: ['form', '[data-type="unified-composer"]'],
      evidence: ['button[aria-label*="Remove"]', 'button[aria-label*="remove"]', '[data-testid*="attachment"]', 'img[src^="blob:"]', 'img[src^="data:image"]', 'img[alt*="Uploaded"]']
    },
    "claude.ai": {
      composer: ['[contenteditable="true"].ProseMirror', '[contenteditable="true"][data-placeholder]', '[role="textbox"][contenteditable="true"]', 'textarea[placeholder]'],
      inputs: ['input[type="file"][accept*="image"]', 'input[type="file"][multiple]', 'input[type="file"]'],
      scope: ['form', '[data-testid="chat-input"]', 'fieldset'],
      evidence: ['button[aria-label*="Remove"]', 'button[aria-label*="remove"]', '[data-testid*="attachment"]', 'img[src^="blob:"]', 'img[src^="data:image"]', '[data-testid*="file-thumbnail"]']
    },
    "gemini.google.com": {
      composer: ['rich-textarea .ql-editor[contenteditable="true"]', '.ql-editor[contenteditable="true"]', '[role="textbox"][contenteditable="true"]', 'textarea'],
      inputs: ['input[type="file"][accept*="image"]', 'input[type="file"][multiple]', 'input[type="file"]'],
      scope: ['input-container', '.input-area-container', 'form'],
      evidence: ['button[aria-label*="Remove"]', 'button[aria-label*="remove"]', 'uploader-file-preview', '.file-preview', 'img[src^="blob:"]', 'img[src^="data:image"]']
    }
  };
  // Declarative injection and executeScript fallback can race. Register just once.
  if (globalThis.__shotToAI === 2) return;
  if (globalThis.__shotToAI) return; // Old installations must reload the AI tab.
  globalThis.__shotToAI = 2;
  const adapter = ADAPTERS[location.hostname];
  if (!adapter) return;
  let queue = Promise.resolve();
  let captureJob = null;
  const completed = new Map();
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const visible = el => !!el?.getClientRects().length && getComputedStyle(el).visibility !== "hidden";
  function first(selectors) {
    for (const selector of selectors) {
      const el = [...document.querySelectorAll(selector)].find(el => visible(el) && !el.disabled);
      if (el) return el;
    }
  }
  function toast(text) {
    document.getElementById("shottoai-toast")?.remove();
    const host = document.createElement("div");
    host.id = "shottoai-toast";
    host.style.cssText = "position:fixed;right:24px;bottom:24px;z-index:2147483647;";
    const box = document.createElement("div");
    box.setAttribute("role", "status");
    box.style.cssText = "background:#15352d;color:white;padding:16px 20px;border:1px solid #60c9a6;border-radius:12px;max-width:380px;font:14px/1.5 system-ui;box-shadow:0 6px 24px #0004";
    box.textContent = text;
    host.attachShadow({mode: "closed"}).append(box);
    document.documentElement.append(host);
    setTimeout(() => host.remove(), 9000);
  }
  function scope(composer) {
    for (const selector of adapter.scope) {
      const el = composer.closest(selector);
      if (el) return el;
    }
    return composer.parentElement?.parentElement?.parentElement || composer.parentElement;
  }
  function evidence(composer) {
    const counts = new Map();
    for (const el of scope(composer).querySelectorAll(adapter.evidence.join(","))) {
      if (!visible(el)) continue;
      const key = [el.tagName, el.getAttribute("src"), el.getAttribute("aria-label"), el.getAttribute("data-testid"), el.textContent?.trim()].join("|");
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
  }
  async function observe(before, filename, timeout = 6000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const composer = first(adapter.composer);
      if (composer) {
        const now = evidence(composer);
        if ([...now].some(([key, count]) => count > (before.get(key) || 0))) return true;
        if ([...scope(composer).querySelectorAll('[title], [aria-label]')].some(el => visible(el) &&
          !composer.contains(el) && [el.title, el.getAttribute("aria-label")].some(s => s?.includes(filename)))) return true;
      }
      await sleep(200);
    }
    return false;
  }
  async function attach({dataUrl, filename}) {
    if (!dataUrl?.startsWith("data:image/png;base64,") || dataUrl.length > 32_000_000) throw new Error("Invalid or oversized PNG.");
    const blob = await (await fetch(dataUrl)).blob();
    const file = new File([blob], filename, {type: "image/png", lastModified: Date.now()});
    const transfer = () => { const dt = new DataTransfer(); dt.items.add(file); return dt; };
    let composer;
    for (let i = 0; i < 60; i++) {
      composer = first(adapter.composer);
      if (composer) break;
      await sleep(250);
    }
    if (!composer) return fallback(blob, "Chat composer not found. Sign in or open a chat.");
    composer.focus();
    const before = evidence(composer);
    const success = method => {
      console.info(`ShotToAI: attachment preview detected (${method}).`);
      toast("Screenshot attached ✓");
      first(adapter.composer)?.focus();
      return {attached: true, method};
    };
    let claimed = false;
    try {
      const event = new ClipboardEvent("paste", {clipboardData: transfer(), bubbles: true, cancelable: true, composed: true});
      claimed = !composer.dispatchEvent(event);
      if (await observe(before, filename)) return success("paste");
    } catch (e) { console.debug("ShotToAI paste:", e.message); }
    // A prevented paste may be an asynchronous upload: allow extra time before the next route.
    if (claimed && await observe(before, filename, 6000)) return success("paste");
    let input;
    for (const selector of adapter.inputs) {
      input = [...document.querySelectorAll(selector)].find(el => !el.disabled && !el.webkitdirectory &&
        (!el.accept || /image|\.png|\*\/\*/i.test(el.accept)));
      if (input) break;
    }
    if (input) {
      try {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files").set.call(input, transfer().files);
        input.dispatchEvent(new Event("change", {bubbles: true, composed: true}));
        input.dispatchEvent(new Event("input", {bubbles: true, composed: true}));
        if (await observe(before, filename)) return success("file input");
      } catch (e) { console.debug("ShotToAI file input:", e.message); }
    }
    composer = first(adapter.composer);
    if (composer) {
      try {
        for (const type of ["dragenter", "dragover", "drop"])
          composer.dispatchEvent(new DragEvent(type, {dataTransfer: transfer(), bubbles: true, cancelable: true, composed: true}));
        if (await observe(before, filename)) return success("drop");
      } catch (e) { console.debug("ShotToAI drop:", e.message); }
    }
    return fallback(blob, "Could not verify an attachment. Check the chat before pasting to avoid duplicates.");
  }
  async function fallback(blob, reason) {
    try {
      await navigator.clipboard.write([new ClipboardItem({"image/png": blob})]);
      toast(`${reason} Screenshot copied: press Ctrl+V (⌘V on Mac).`);
      return {attached: false, copied: true, reason};
    } catch {
      toast(`${reason} Use the Copy image button on this page.`);
      return {attached: false, copied: false, reason};
    }
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message.type === "SHOT_PING") { respond({ok: true, version: 2, jobId: captureJob}); return; }
    if (message.type === "SHOT_TOAST") { toast(message.text); respond({ok: true}); return; }
    if (message.type === "SHOT_PREPARE") {
      if (captureJob || location.href !== message.targetUrl) respond({error: "Finish the current capture or reload this chat."});
      else { captureJob = message.jobId; respond({ok: true}); }
      return;
    }
    if (message.type === "SHOT_RELEASE") {
      if (captureJob === message.jobId) captureJob = null;
      respond({ok: true}); return;
    }
    if (message.type === "SHOT_CAPTURE") {
      if (captureJob !== message.jobId || typeof globalThis.__shotCapture !== "function") {
        respond({error: "Capture expired. Reload this chat and try again."}); return;
      }
      globalThis.__shotCapture(message, attach, toast).then(respond, e => {
        toast(`ShotToAI: ${e.message}`); respond({error: e.message});
      }).finally(() => { captureJob = null; });
      return true;
    }
    if (message.type !== "SHOT_ATTACH") return;
    queue = queue.catch(() => {}).then(async () => {
      if (completed.has(message.filename)) return completed.get(message.filename);
      const result = await attach(message);
      completed.set(message.filename, result);
      if (completed.size > 20) completed.delete(completed.keys().next().value);
      return result;
    });
    queue.then(respond, e => { toast(`ShotToAI: ${e.message}`); respond({error: e.message}); });
    return true;
  });
})();
```

## shottoai/page-capture.js

```javascript
(() => {
  if (globalThis.__shotCapture) return;
  const pngData = blob => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  const copy = blob => navigator.clipboard.write([new ClipboardItem({"image/png": blob})]);

  async function frame(streamId) {
    let stream, timer, expired = false;
    const stop = () => { stream?.getTracks().forEach(t => t.stop()); };
    const onHide = () => { expired = true; stop(); };
    window.addEventListener("pagehide", onHide);
    const video = document.createElement("video");
    video.muted = true;
    try {
      const media = navigator.mediaDevices.getUserMedia({audio: false, video: {mandatory: {
        chromeMediaSource: "desktop", chromeMediaSourceId: streamId, maxWidth: 16384, maxHeight: 16384
      }}});
      // Even a stream resolving after timeout/navigation must release every track.
      media.then(s => { if (expired) s.getTracks().forEach(t => t.stop()); }, () => {});
      stream = await Promise.race([media, new Promise((_, reject) => {
        timer = setTimeout(() => { expired = true; reject(new Error("Screen capture timed out.")); }, 15000);
      })]);
      clearTimeout(timer);
      if (expired) throw new Error("Capture cancelled by navigation.");
      video.srcObject = stream;
      await Promise.race([(async () => {
        await video.play();
        await new Promise(resolve => video.requestVideoFrameCallback(resolve));
      })(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("No video frame received.")), 10000); })]);
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      if (!canvas.width || !canvas.height) throw new Error("The source has no visible frame.");
      canvas.getContext("2d").drawImage(video, 0, 0);
      return canvas;
    } finally {
      clearTimeout(timer);
      stop(); // Release capture BEFORE displaying an overlay or encoding/uploading.
      video.srcObject = null;
      window.removeEventListener("pagehide", onHide);
    }
  }
  function panel() {
    document.getElementById("shottoai-panel")?.remove();
    const host = document.createElement("div");
    host.id = "shottoai-panel";
    host.style.cssText = "position:fixed!important;inset:0!important;z-index:2147483646!important;display:grid!important;place-items:center!important;background:#0009!important";
    const shadow = host.attachShadow({mode: "closed"});
    const box = document.createElement("section");
    box.setAttribute("role", "dialog"); box.setAttribute("aria-label", "ShotToAI screenshot");
    box.style.cssText = "font:15px/1.5 system-ui;background:#14252b;color:#edf5f2;padding:24px;border:1px solid #609b88;border-radius:14px;max-width:90vw;max-height:90vh;overflow:auto";
    shadow.append(box);
    document.documentElement.append(host);
    const text = document.createElement("p"); box.append(text);
    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:12px;flex-wrap:wrap;margin-top:16px";
    const button = (label, action) => {
      const b = document.createElement("button");
      b.textContent = label; b.type = "button";
      b.style.cssText = "font:600 15px system-ui;border:0;border-radius:8px;padding:12px 18px;background:#87e3c3;color:#102a20;cursor:pointer";
      b.onclick = action; actions.append(b); return b;
    };
    box.append(actions);
    return {host, box, text, actions, button};
  }
  function cropPreview(original) {
    return new Promise(resolve => {
      const ui = panel();
      ui.text.textContent = "Drag a rectangle to crop, or attach the whole screenshot.";
      const canvas = document.createElement("canvas");
      canvas.width = original.width; canvas.height = original.height;
      canvas.style.cssText = "display:block;max-width:82vw;max-height:60vh;touch-action:none;cursor:crosshair";
      ui.box.insertBefore(canvas, ui.actions);
      let start, crop = null;
      const ctx = canvas.getContext("2d");
      const draw = () => {
        ctx.drawImage(original, 0, 0);
        if (!crop) return;
        ctx.fillStyle = "#0008"; ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(original, crop.x, crop.y, crop.w, crop.h, crop.x, crop.y, crop.w, crop.h);
        ctx.strokeStyle = "#87e3c3"; ctx.lineWidth = Math.max(2, canvas.width / 500);
        ctx.strokeRect(crop.x, crop.y, crop.w, crop.h);
      };
      const point = e => {
        const r = canvas.getBoundingClientRect();
        return {x: Math.max(0, Math.min(canvas.width, (e.clientX - r.left) * canvas.width / r.width)),
          y: Math.max(0, Math.min(canvas.height, (e.clientY - r.top) * canvas.height / r.height))};
      };
      canvas.onpointerdown = e => { start = point(e); crop = null; canvas.setPointerCapture(e.pointerId); draw(); };
      canvas.onpointermove = e => {
        if (!start) return;
        const p = point(e);
        crop = {x: Math.min(p.x, start.x), y: Math.min(p.y, start.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y)};
        draw();
      };
      canvas.onpointerup = canvas.onpointercancel = () => {
        start = null;
        if (crop && (crop.w < 8 || crop.h < 8)) crop = null;
        draw();
      };
      const finish = result => { ui.host.remove(); window.removeEventListener("keydown", escape, true); resolve(result); };
      const escape = e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish({cancelled: true}); } };
      window.addEventListener("keydown", escape, true);
      ui.button("Attach screenshot", () => finish({crop}));
      ui.button("Reset crop", () => { crop = null; draw(); });
      ui.button("Cancel", () => finish({cancelled: true})).focus();
      draw();
    });
  }
  function recovery(blob, reason) {
    const ui = panel();
    ui.text.textContent = reason;
    ui.button("Copy image", async () => {
      try { await copy(blob); ui.text.textContent = "Copied. Close this panel, check existing attachments, then press Ctrl+V (⌘V on Mac) if needed."; }
      catch (e) { ui.text.textContent = `Clipboard failed: ${e.message}`; }
    }).focus();
    ui.button("Close", () => ui.host.remove());
  }
  globalThis.__shotCapture = async (message, attach, toast) => {
    const {streamId, jobId, targetUrl, settings} = message;
    const request = async (type, extra = {}) => {
      const result = await chrome.runtime.sendMessage({type, jobId, ...extra});
      if (result?.error) throw new Error(result.error);
      return result;
    };
    const checkLocation = () => {
      if (location.href !== targetUrl) throw new Error("The chat changed. Copy the image and paste it into the intended conversation.");
    };
    // Crop may remain open for minutes; keep the worker's reply channel alive.
    const heartbeat = setInterval(() => request("SHOT_HEARTBEAT").catch(() => {}), 20000);
    let blob;
    try {
      checkLocation();
      document.getElementById("shottoai-toast")?.remove();
      document.getElementById("shottoai-panel")?.remove();
      const original = await frame(streamId);
      // Chrome may focus the selected source. Restore the same chat after the frame is frozen.
      await request("SHOT_FOCUS");
      const result = settings.crop ? await cropPreview(original) : {crop: null};
      if (result.cancelled) { toast("Screenshot capture cancelled."); return {cancelled: true}; }
      const r = result.crop || {x: 0, y: 0, w: original.width, h: original.height};
      const scale = Math.min(1, settings.maxWidth / r.w);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(r.w * scale)); canvas.height = Math.max(1, Math.round(r.h * scale));
      canvas.getContext("2d").drawImage(original, r.x, r.y, r.w, r.h, 0, 0, canvas.width, canvas.height);
      blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("PNG encoding failed.");
      checkLocation();
      const dataUrl = await pngData(blob);
      if (dataUrl.length > 32_000_000) throw new Error("PNG is too large. Reduce maximum width in Options.");
      const filename = `ShotToAI-${new Date().toISOString().replace(/[:.]/g, "-")}-${jobId.slice(0, 8)}.png`;
      const warnings = [];
      if (settings.copy) await copy(blob).catch(e => warnings.push(`Clipboard: ${e.message}`));
      if (settings.save) await request("SHOT_SAVE", {dataUrl, filename}).catch(e => warnings.push(`Download: ${e.message}`));
      checkLocation();
      const attached = await attach({dataUrl, filename});
      if (!attached.attached && !attached.copied) recovery(blob, attached.reason || "Automatic attachment failed. Copy the screenshot here.");
      else if (warnings.length) toast(`${attached.attached ? "Screenshot attached. " : ""}${warnings.join(" ")}`);
      return attached;
    } catch (e) {
      if (blob) recovery(blob, e.message);
      throw e;
    } finally { clearInterval(heartbeat); }
  };
})();
```

## shottoai/options.html

```html
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ShotToAI options</title><link rel="stylesheet" href="style.css"></head>
<body><main class="options">
<h1>ShotToAI options</h1><p>Capture once. Attach to your chat. Send when you are ready.</p>
<form id="options">
  <label>Default AI site<select id="defaultSite"><option value="chatgpt.com">ChatGPT</option><option value="claude.ai">Claude</option><option value="gemini.google.com">Gemini</option></select></label>
  <label>Maximum image width (pixels)<input id="maxWidth" type="number" min="320" max="7680" step="1" required></label>
  <label class="check"><input type="checkbox" id="copy"> Copy to clipboard as well</label>
  <label class="check"><input type="checkbox" id="save"> Also save a PNG to Downloads/ShotToAI</label>
  <label class="check"><input type="checkbox" id="crop"> Preview and crop before attaching</label>
  <button type="submit">Save options</button>
</form>
<p id="status" role="status" aria-live="polite"></p>
<button id="shortcuts" class="secondary">Configure keyboard shortcut</button>
<p>The default is Ctrl+Shift+S, including Control on Mac. Change conflicts in Chrome.</p>
<p>No ShotToAI servers or analytics. Your AI website may upload an attachment immediately, before you send the message.</p>
</main><script type="module" src="options.js"></script></body></html>
```

## shottoai/options.js

```javascript
import {settings, DEFAULTS} from "./shared.js";
const $ = id => document.getElementById(id);
settings().then(s => {
  for (const key of Object.keys(DEFAULTS)) {
    if (typeof DEFAULTS[key] === "boolean") $(key).checked = s[key];
    else $(key).value = s[key];
  }
}).catch(e => { $("status").textContent = e.message; });
$("save").onchange = async () => {
  if (!$("save").checked) return;
  try {
    // Request optional permission directly from this checkbox's user gesture.
    if (!await chrome.permissions.request({permissions: ["downloads"]})) {
      $("save").checked = false;
      $("status").textContent = "Downloads permission was declined. Other features still work.";
    }
  } catch (e) { $("save").checked = false; $("status").textContent = e.message; }
};
$("options").onsubmit = async e => {
  e.preventDefault();
  try {
    const s = {};
    for (const key of Object.keys(DEFAULTS)) s[key] = typeof DEFAULTS[key] === "boolean" ? $(key).checked : $(key).value;
    s.maxWidth = Number(s.maxWidth);
    if (s.save && !await chrome.permissions.contains({permissions: ["downloads"]})) throw new Error("Enable Downloads permission using its checkbox first.");
    await chrome.storage.local.set(s);
    if (!s.save) await chrome.permissions.remove({permissions: ["downloads"]});
    $("status").textContent = "Options saved. They apply to the next capture.";
  } catch (error) { $("status").textContent = error.message; }
};
$("shortcuts").onclick = () => chrome.tabs.create({url: "chrome://extensions/shortcuts"});
```

## shottoai/style.css

```css
:root { color-scheme: dark; font: 16px/1.6 system-ui, sans-serif; background: #101b20; color: #edf5f2; }
* { box-sizing: border-box; }
body { margin: 0; padding: 36px 24px; }
main { max-width: 1100px; margin: auto; }
main.options { max-width: 640px; }
h1 { font-size: 32px; letter-spacing: -.8px; margin: 0 0 12px; }
p { color: #b8cbc6; }
#status { color: #9aefd3; white-space: pre-wrap; }
label { display: block; margin: 24px 0; }
select, input[type=number] { display: block; width: 100%; padding: 12px; margin-top: 8px; background: #203139; color: inherit; border: 1px solid #537068; border-radius: 8px; font: inherit; }
.check { display: flex; gap: 12px; align-items: center; }
input[type=checkbox] { width: 20px; height: 20px; accent-color: #87e3c3; }
button { border: 1px solid transparent; border-radius: 8px; padding: 12px 20px; background: #87e3c3; color: #102a20; cursor: pointer; font: 600 15px system-ui; }
button.secondary { border-color: #537068; background: #203139; color: #edf5f2; }
button:disabled { opacity: .5; cursor: wait; }
button:focus-visible, input:focus-visible, select:focus-visible { outline: 3px solid #b6ffe7; outline-offset: 3px; }
.actions { display: flex; gap: 12px; flex-wrap: wrap; margin: 20px 0; }
canvas { display: block; max-width: 100%; max-height: 68vh; width: auto; height: auto; cursor: crosshair; touch-action: none; }
[hidden] { display: none !important; }
```

## tests/core.test.cjs

```javascript
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..', 'shottoai');
const source = name => fs.readFileSync(path.join(root, name), 'utf8');

async function exerciseAdapter(route, hostname = 'chatgpt.com') {
  let handler, time = 0, added = false, copied = false;
  const events = [];
  const preview = {tagName: 'IMG', textContent: '', getClientRects: () => [1], getAttribute: n => n === 'src' ? 'blob:attachment' : null};
  const scope = {querySelectorAll: () => added ? [preview] : []};
  const dispatch = e => { events.push(e.type); if (e.type === route) added = true; return true; };
  const composer = {getClientRects: () => [1], focus() {}, closest: () => scope, contains: () => false, dispatchEvent: dispatch};
  class Input { set files(value) { this.value = value; } get files() { return this.value; } }
  const input = new Input();
  input.accept = 'image/*'; input.dispatchEvent = dispatch;
  const document = {
    querySelectorAll: s => s.includes('input[type="file"]') ? [input] : route === 'missing' ? [] : [composer],
    getElementById: () => null,
    createElement: () => ({style: {}, setAttribute() {}, attachShadow: () => ({append() {}}), remove() {}}),
    documentElement: {append() {}}
  };
  class SyntheticEvent { constructor(type, init) { this.type = type; Object.assign(this, init); } }
  class Transfer { constructor() { this.files = []; this.items = {add: f => this.files.push(f)}; } }
  const context = vm.createContext({
    document, location: {hostname}, getComputedStyle: () => ({visibility: 'visible'}),
    chrome: {runtime: {id: 'test', onMessage: {addListener: f => handler = f}}},
    navigator: {clipboard: {write: async () => { copied = true; }}},
    Blob, File, fetch, ClipboardItem: class {constructor(value) {this.value = value;}},
    ClipboardEvent: SyntheticEvent, DragEvent: SyntheticEvent, Event: SyntheticEvent,
    HTMLInputElement: Input, DataTransfer: Transfer, console,
    Date: class extends Date {static now() {return time;}},
    setTimeout: (f, ms) => {time += ms; queueMicrotask(f);}
  });
  vm.runInContext(source('content.js'), context);
  const payload = {type: 'SHOT_ATTACH', dataUrl: 'data:image/png;base64,AA==', filename: 'unit.png'};
  const send = () => new Promise(resolve => handler(payload, {id: 'test'}, resolve));
  const result = await send();
  const eventCount = events.length;
  await send();
  assert.equal(events.length, eventCount, 're-delivery must not dispatch events again');
  return {result, events, copied};
}
for (const [route, method, expected] of [
  ['paste', 'paste', ['paste']],
  ['change', 'file input', ['paste', 'change', 'input']],
  ['drop', 'drop', ['paste', 'change', 'input', 'dragenter', 'dragover', 'drop']]
]) test('adapter route ' + method + ' requires visible evidence and follows fallback order', async () => {
  const r = await exerciseAdapter(route);
  assert.equal(r.result.attached, true);
  assert.equal(r.result.method, method);
  assert.deepEqual(r.events, expected);
  assert.equal(r.copied, false);
});
test('dispatching events alone is not success: clipboard is used after all routes fail', async () => {
  const r = await exerciseAdapter('none');
  assert.equal(r.result.attached, false);
  assert.equal(r.copied, true);
  assert.deepEqual(r.events, ['paste', 'change', 'input', 'dragenter', 'dragover', 'drop']);
});
test('missing composer falls back to clipboard without event injection', async () => {
  const r = await exerciseAdapter('missing');
  assert.equal(r.result.attached, false);
  assert.equal(r.copied, true);
  assert.deepEqual(r.events, []);
});
for (const host of ['claude.ai', 'gemini.google.com']) test(host + ' adapter handles an observed paste attachment', async () => {
  assert.equal((await exerciseAdapter('paste', host)).result.method, 'paste');
});
```

## tests/worker.test.cjs

```javascript
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..', 'shottoai');
const source = name => fs.readFileSync(path.join(root, name), 'utf8');
function worker(tabs, initial = {}) {
  tabs.forEach(t => { t.status ??= 'complete'; });
  const state = {...initial}, events = {}, calls = [];
  let next = 100;
  const chrome = {
    action: {onClicked: {addListener: f => events.click = f}, setBadgeText: async x => calls.push(['badge', x]), setTitle: async () => {}},
    commands: {onCommand: {addListener: f => events.command = f}},
    windows: {update: async (...args) => calls.push(['window', ...args])},
    desktopCapture: {
      chooseDesktopMedia: (sources, tab, callback) => {
        calls.push(['picker', tab.id, [...sources]]);
        events.pick = callback;
        queueMicrotask(() => callback('stream-token'));
        return 42;
      },
      cancelChooseDesktopMedia: id => calls.push(['cancel', id])
    },
    tabs: {
      query: async q => tabs.filter(t => !q.active || t.active),
      get: async id => { const t = tabs.find(t => t.id === id); if (!t) throw Error('No tab'); return t; },
      create: async args => { const t = {id: next++, windowId: 1, status: 'complete', ...args}; tabs.push(t); calls.push(['create', args]); return t; },
      update: async (id, args) => { calls.push(['update', id, args]); const t = tabs.find(t => t.id === id); Object.assign(t, args); return t; },
      onRemoved: {addListener: f => events.remove = f},
      onUpdated: {addListener: f => events.update = f},
      sendMessage: async (id, m) => { calls.push(['message', id, m]); return m.type === 'SHOT_PING' ? {version: 2} : {ok: true, attached: true}; }
    },
    storage: {
      session: {get: async () => ({...state}), set: async data => Object.assign(state, data), remove: async key => delete state[key]},
      local: {get: async defaults => ({...defaults})}
    },
    scripting: {executeScript: async args => calls.push(['inject', args])},
    runtime: {id: 'unit-extension', onMessage: {addListener: f => events.message = f}},
    permissions: {contains: async () => true},
    downloads: {download: async args => calls.push(['download', args])}
  };
  const context = vm.createContext({chrome, crypto: require('node:crypto').webcrypto, URL, console, setTimeout});
  vm.runInContext(source('shared.js').replaceAll('export ', '') + '\n' + source('background.js').replace(/^import .*;\r?\n/, ''), context);
  return {context, events, state, calls, chrome, tabs,
    start: tab => { context.origin = tab; return vm.runInContext('start(origin)', context); }};
}
const chat = () => ({id: 1, url: 'https://chatgpt.com/c/test', windowId: 1, lastAccessed: 1});
test('capture on current AI chat creates no tab, navigates nowhere, and binds picker to that chat', async () => {
  const active = chat();
  const w = worker([active, {id: 2, url: 'https://claude.ai/new', lastAccessed: 100}]);
  await w.start(active);
  assert.equal(w.calls.filter(c => c[0] === 'create' || c[0] === 'update').length, 0);
  assert.deepEqual(w.calls.find(c => c[0] === 'picker'), ['picker', 1, ['tab', 'window', 'screen']]);
  const sent = w.calls.find(c => c[0] === 'message' && c[2].type === 'SHOT_CAPTURE');
  assert.equal(sent[1], 1); assert.equal(sent[2].streamId, 'stream-token');
  assert.equal(w.state.job, undefined);
});
test('unsupported active tab uses most recent existing AI tab without creating a capture tab', async () => {
  const w = worker([chat(), {id: 2, url: 'https://gemini.google.com/app', lastAccessed: 3}]);
  await w.start({id: 3, url: 'https://example.com'});
  assert.equal(w.calls.find(c => c[0] === 'picker')[1], 2);
  assert.equal(w.calls.filter(c => c[0] === 'create').length, 0);
});
test('only the default AI site opens when there is no supported destination', async () => {
  const w = worker([]); await w.start({});
  const created = w.calls.filter(c => c[0] === 'create');
  assert.equal(created.length, 1);
  assert.equal(created[0][1].url, 'https://chatgpt.com/');
});
test('lookalike domains and insecure URLs are not supported', () => {
  const w = worker([]);
  for (const url of ['https://chatgpt.com.evil.test', 'http://chatgpt.com', 'https://evil.test/chatgpt.com', 'invalid']) {
    w.context.url = url; assert.equal(vm.runInContext('supported(url)', w.context), false);
  }
});
test('cancelling picker releases job without starting capture, and another capture works', async () => {
  const tab = chat(), w = worker([tab]);
  const choose = w.chrome.desktopCapture.chooseDesktopMedia;
  w.chrome.desktopCapture.chooseDesktopMedia = (s, t, cb) => { queueMicrotask(() => cb('')); return 1; };
  await w.start(tab);
  assert.equal(w.calls.filter(c => c[0] === 'message' && c[2].type === 'SHOT_CAPTURE').length, 0);
  assert.equal(w.state.job, undefined);
  w.chrome.desktopCapture.chooseDesktopMedia = choose;
  await w.start(tab);
  assert.ok(w.calls.some(c => c[0] === 'message' && c[2].type === 'SHOT_CAPTURE'));
});
test('concurrent trigger does not open another picker', async () => {
  const tab = chat(), w = worker([tab]);
  await Promise.all([w.start(tab), w.start(tab)]);
  assert.equal(w.calls.filter(c => c[0] === 'picker').length, 1);
});
test('worker restart respects crop job still running in content script', async () => {
  const tab = chat(), w = worker([tab], {job: {id: 'pending', targetId: 1}});
  w.chrome.tabs.sendMessage = async (id, m) => m.type === 'SHOT_PING' ? {version: 2, jobId: 'pending'} : {ok: true};
  await w.start(tab);
  assert.equal(w.calls.filter(c => c[0] === 'picker' || c[0] === 'create').length, 0);
  assert.equal(w.state.job.id, 'pending');
});
for (const change of ['navigate', 'close']) test(change + ' during picker prevents screenshot delivery', async () => {
  const tab = chat(), w = worker([tab]);
  w.chrome.desktopCapture.chooseDesktopMedia = (s, t, cb) => {
    queueMicrotask(() => { if (change === 'navigate') tab.url = 'https://chatgpt.com/c/other'; else w.tabs.splice(0, 1); cb('token'); });
    return 1;
  };
  await w.start(tab);
  assert.equal(w.calls.filter(c => c[0] === 'message' && c[2].type === 'SHOT_CAPTURE').length, 0);
});
test('missing content scripts inject both capture and site adapters', async () => {
  const w = worker([]);
  w.chrome.tabs.sendMessage = async (id, m) => { if (m.type === 'SHOT_PING') throw Error('No receiver'); return {ok: true}; };
  await vm.runInContext('pageMessage(1, {type: "SHOT_PREPARE"})', w.context);
  assert.equal(w.calls.filter(c => c[0] === 'inject').length, 1);
  assert.deepEqual([...w.calls.find(c => c[0] === 'inject')[1].files], ['page-capture.js', 'content.js']);
});
test('another tab cannot save the capture even with its job ID', async () => {
  const w = worker([], {job: {id: 'secret', targetId: 1, targetUrl: 'https://chatgpt.com/', settings: {save: true}}});
  const result = await new Promise(resolve => w.events.message({type: 'SHOT_SAVE', jobId: 'secret'},
    {id: 'unit-extension', frameId: 0, url: 'https://chatgpt.com/', tab: {id: 2}}, resolve));
  assert.match(result.error, /expired/);
  assert.equal(w.calls.filter(c => c[0] === 'download').length, 0);
});
test('manifest loads page capture and has no popup or capture page', () => {
  const m = JSON.parse(source('manifest.json'));
  assert.deepEqual(m.content_scripts[0].js, ['page-capture.js', 'content.js']);
  assert.equal(m.host_permissions.length, 3);
  assert.deepEqual(m.optional_permissions, ['downloads']);
  assert.ok(!m.action.default_popup);
  assert.ok(!fs.existsSync(path.join(root, 'capture.html')));
});
```

## tests/capture.test.cjs

```javascript
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function harness({playError = false} = {}) {
  const nodes = [], events = [], intervals = new Set();
  let stopped = 0, attached = 0;
  const location = {href: 'https://chatgpt.com/c/test'};
  const create = tag => {
    const node = {tag, style: {}, children: [], width: 0, height: 0,
      setAttribute() {}, append(...items) {this.children.push(...items);},
      attachShadow() {return create('shadow');}, insertBefore(n) {this.children.push(n);},
      focus() {}, remove() {this.removed = true;}, setPointerCapture() {},
      getBoundingClientRect() {return {left: 0, top: 0, width: this.width, height: this.height};},
      getContext() {return {drawImage() {}, fillRect() {}, strokeRect() {}};},
      toBlob(cb) {events.push(['encode', this.width, this.height]); cb(new Blob(['png'], {type: 'image/png'}));}
    };
    if (tag === 'video') Object.assign(node, {videoWidth: 3840, videoHeight: 2160,
      play: async () => {if (playError) throw Error('frame failed');}, requestVideoFrameCallback: f => queueMicrotask(f)});
    nodes.push(node); return node;
  };
  const context = vm.createContext({
    location, Blob, console, Date, Math,
    window: {addEventListener() {}, removeEventListener() {}},
    document: {getElementById: id => nodes.find(n => n.id === id && !n.removed), createElement: create, documentElement: create('root')},
    navigator: {mediaDevices: {getUserMedia: async args => {
      events.push(['media', args]);
      return {getTracks: () => [{stop() {stopped++; events.push(['stop']);}}]};
    }}, clipboard: {write: async () => events.push(['copy'])}},
    ClipboardItem: class {},
    FileReader: class {readAsDataURL() {this.result = 'data:image/png;base64,cG5n'; queueMicrotask(() => this.onload());}},
    chrome: {runtime: {sendMessage: async m => {events.push(['message', m.type]); return {ok: true};}}},
    setTimeout, clearTimeout,
    setInterval: f => {intervals.add(f); return f;}, clearInterval: f => intervals.delete(f)
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../shottoai/page-capture.js'), 'utf8'), context);
  const run = (settings = {}) => context.__shotCapture({streamId: 'token', jobId: 'job-12345678', targetUrl: 'https://chatgpt.com/c/test',
    settings: {crop: false, copy: false, save: false, maxWidth: 1920, ...settings}}, async () => {
    assert.equal(stopped, 1, 'capture tracks must already be stopped at attachment'); attached++;
    return {attached: true};
  }, text => events.push(['toast', text]));
  const button = label => nodes.find(n => n.tag === 'button' && n.textContent === label);
  const waitButton = async label => {
    for (let i = 0; i < 20; i++) { if (button(label)) return button(label); await new Promise(setImmediate); }
    throw Error('Missing button: ' + label);
  };
  return {run, nodes, events, intervals, location, button, waitButton, stopped: () => stopped, attached: () => attached};
}
test('page capture stops media before encoding, downscales and attaches without any new page', async () => {
  const h = harness();
  assert.equal((await h.run()).attached, true);
  assert.deepEqual(h.events.find(e => e[0] === 'encode'), ['encode', 1920, 1080]);
  assert.ok(h.events.findIndex(e => e[0] === 'stop') < h.events.findIndex(e => e[0] === 'encode'));
  assert.equal(h.events.find(e => e[0] === 'media')[1].video.mandatory.chromeMediaSourceId, 'token');
  assert.equal(h.nodes.some(n => n.id === 'shottoai-panel'), false);
  assert.equal(h.intervals.size, 0);
});
test('crop is an in-page overlay shown after tracks stop; Cancel does not attach', async () => {
  const h = harness(), pending = h.run({crop: true});
  const cancel = await h.waitButton('Cancel');
  assert.equal(h.stopped(), 1);
  assert.ok(h.nodes.some(n => n.id === 'shottoai-panel'));
  cancel.onclick();
  assert.equal((await pending).cancelled, true);
  assert.equal(h.attached(), 0);
  assert.equal(h.intervals.size, 0);
});
test('dragging crop overlay attaches selected rectangle and removes overlay', async () => {
  const h = harness(), pending = h.run({crop: true});
  const send = await h.waitButton('Attach screenshot');
  const canvas = h.nodes.filter(n => n.tag === 'canvas')[1];
  canvas.onpointerdown({clientX: 500, clientY: 300, pointerId: 1});
  canvas.onpointermove({clientX: 100, clientY: 100});
  canvas.onpointerup(); send.onclick(); await pending;
  assert.deepEqual(h.events.find(e => e[0] === 'encode'), ['encode', 400, 200]);
  assert.equal(h.attached(), 1);
  assert.ok(h.nodes.find(n => n.id === 'shottoai-panel').removed);
});
test('navigation during crop refuses attachment and offers copy on the same page', async () => {
  const h = harness(), pending = h.run({crop: true});
  const send = await h.waitButton('Attach screenshot');
  h.location.href = 'https://chatgpt.com/c/other'; send.onclick();
  await assert.rejects(pending, /chat changed/);
  assert.equal(h.attached(), 0);
  assert.ok(h.button('Copy image'));
  assert.equal(h.intervals.size, 0);
});
test('video failure still stops tracks and clears heartbeat', async () => {
  const h = harness({playError: true});
  await assert.rejects(h.run(), /frame failed/);
  assert.equal(h.stopped(), 1);
  assert.equal(h.attached(), 0);
  assert.equal(h.intervals.size, 0);
});
test('clipboard and download options work in the page capture path', async () => {
  const h = harness(); await h.run({copy: true, save: true});
  assert.ok(h.events.some(e => e[0] === 'copy'));
  assert.ok(h.events.some(e => e[0] === 'message' && e[1] === 'SHOT_SAVE'));
  assert.equal(h.attached(), 1);
});
```

