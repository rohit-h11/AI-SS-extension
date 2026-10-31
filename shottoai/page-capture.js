(() => {
  if (globalThis.__shotCapture) return;
  const pngData = blob => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  const copy = blob => navigator.clipboard.write([new ClipboardItem({"image/png": blob})]);

  async function frame(streamId, onSourceReady) {
    let stream, video, expired = false;
    const bounded = async (operation, ms, message) => {
      let timer;
      try {
        return await Promise.race([operation, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(message)), ms);
        })]);
      } finally { clearTimeout(timer); }
    };
    const stop = () => { stream?.getTracks().forEach(t => t.stop()); };
    const onHide = () => { expired = true; stop(); };
    window.addEventListener("pagehide", onHide);
    try {
      const media = navigator.mediaDevices.getUserMedia({audio: false, video: {mandatory: {
        chromeMediaSource: "desktop", chromeMediaSourceId: streamId, maxWidth: 16384, maxHeight: 16384
      }}});
      // Even a stream resolving after timeout/navigation must release every track.
      media.then(s => { if (expired) s.getTracks().forEach(t => t.stop()); }, () => {});
      try { stream = await bounded(media, 15000, "Screen capture timed out."); }
      catch (e) { expired = true; throw e; }
      if (expired) throw new Error("Capture cancelled by navigation.");
      const track = stream.getVideoTracks()[0];
      if (!track) throw new Error("The selected source has no video track.");
      // Tab capture stays valid when the captured tab is in the background. Return
      // to the chat now; for screen/window sources wait until the frame is frozen.
      if (track.getSettings().displaySurface === "browser") await onSourceReady();
      const draw = (image, width, height) => {
        if (!width || !height) throw new Error("The source has no visible frame.");
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        canvas.getContext("2d").drawImage(image, 0, 0);
        return canvas;
      };
      if (typeof ImageCapture === "function") {
        let bitmap, abandoned = false;
        try {
          // Grab directly from the track. A hidden/detached video's compositor
          // callback may never run while Chrome has focused the selected tab.
          const pending = new ImageCapture(track).grabFrame();
          pending.then(value => { if (abandoned) value.close(); }, () => {});
          bitmap = await bounded(pending, 4000, "Direct frame capture timed out.");
          return draw(bitmap, bitmap.width, bitmap.height);
        } catch (e) {
          console.debug("ShotToAI: using decoded-video fallback:", e.message);
        } finally { abandoned = true; bitmap?.close(); }
      }
      // Fallback waits for decoded data, not a compositor/animation callback.
      video = document.createElement("video");
      video.muted = true; video.playsInline = true; video.srcObject = stream;
      let decoding = true;
      try {
        await bounded((async () => {
          await video.play();
          while (decoding && !expired && (video.readyState < 2 || !video.videoWidth || !video.videoHeight)) {
            if (video.error || track.readyState === "ended") throw new Error("Screen capture ended before a frame arrived.");
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          if (!decoding || expired) throw new Error("Frame capture cancelled.");
        })(), 5000, "No decoded screenshot frame received.");
        return draw(video, video.videoWidth, video.videoHeight);
      } finally { decoding = false; }
    } finally {
      stop(); // Release capture BEFORE displaying an overlay or encoding/uploading.
      if (video) { video.pause(); video.srcObject = null; }
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
      let original;
      try { original = await frame(streamId, () => request("SHOT_FOCUS")); }
      finally {
        // Also return to the chat on capture failure, after releasing all tracks.
        await request("SHOT_FOCUS").catch(() => {});
      }
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
