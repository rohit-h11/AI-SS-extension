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
