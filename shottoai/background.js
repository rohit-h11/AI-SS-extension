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
