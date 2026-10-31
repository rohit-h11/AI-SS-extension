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
