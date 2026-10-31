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
