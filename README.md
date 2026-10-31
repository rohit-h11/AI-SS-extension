# ShotToAI

Complete vanilla-JavaScript Manifest V3 source is in `shottoai/`. No build or dependency installation is required.

## Architecture

Version 1.1 captures directly from the current AI tab. Clicking the icon or shortcut opens Chrome's native picker without opening an extension tab or navigating the chat. A single in-flight job is kept in `chrome.storage.session`; screenshot bytes remain in memory. If triggered outside a supported AI site, the most recently accessed supported tab is used. Only when no supported AI tab exists does the original default-site fallback open one.

The service worker calls `chrome.desktopCapture.chooseDesktopMedia` with the destination AI tab as `targetTab`. Chrome binds its one-use stream token to that tab's secure origin. `page-capture.js` consumes the token with `getUserMedia` inside the content script, draws one decoded frame to a canvas, and immediately stops every track. Cropping and clipboard recovery use shadow-DOM overlays in the same AI page. There is no popup, capture tab, or offscreen document. If Chrome focuses the selected source, ShotToAI restores the original chat after freezing the frame. Capture uses desktopCapture so no transient getDisplayMedia activation has to be forwarded between contexts.

The content script has a per-site adapter for ChatGPT, Claude, and Gemini. It tries paste, file input, drop, then clipboard. It waits for new visible attachment UI evidence before reporting success; successful event dispatch alone is insufficient. It never submits a chat message or clears existing composer text/attachments. Attachment recognition is necessarily heuristic, since these sites provide no supported extension upload contract.

References:
- https://developer.chrome.com/docs/extensions/reference/api/desktopCapture
- https://developer.chrome.com/docs/extensions/reference/api/offscreen

## Files

```text
Extension/
  shottoai/
    manifest.json
    background.js
    shared.js
    content.js
    page-capture.js
    options.html
    options.js
    style.css
  tests/
    core.test.cjs
    worker.test.cjs
    capture.test.cjs
  README.md
  FULL_SOURCE.md
```

`FULL_SOURCE.md` contains every extension file in full in separate named code blocks, plus the test suite.

## Load unpacked

1. Use desktop Google Chrome 116 or newer on Windows, macOS, or Linux.
2. Open `chrome://extensions`.
3. Enable **Developer mode** at the top right.
4. Click **Load unpacked**.
5. Select the `shottoai` directory containing `manifest.json` (in this workspace: `F:\Coding\projects\Extension\shottoai`). Do not select the parent directory.
6. Open Chrome's Extensions puzzle menu and pin **ShotToAI**.
7. Open `chrome://extensions/shortcuts`; verify ShotToAI has Ctrl+Shift+S. The Mac default is physical Control+Shift+S. Conflicts may leave it unassigned; choose another shortcut if needed.
8. Open or reload your AI chat tab. Sign in yourself if needed. Right-click ShotToAI's icon and select **Options** to change defaults, max width, crop, clipboard, or Downloads.
9. Click the icon or press the shortcut. In Chrome's native picker, choose a tab/window/screen and click **Share**. No audio is requested.
10. If crop is enabled, drag a rectangle in the preview and click **Attach screenshot**, or attach without dragging for the full image. **Reset crop** restores the full frame.
11. Check the image attachment, then type your question. ShotToAI never presses Send.

For another screenshot, trigger again after the prior capture finishes. The existing conversation and attachments are retained. Cancelling the native picker or crop overlay releases the job immediately. Close any clipboard-recovery overlay before starting another screenshot. To upgrade from 1.0, reload ShotToAI in `chrome://extensions`, refresh your AI tabs, and close any old ShotToAI capture tab.

## Permissions

- `desktopCapture`: displays Chrome's native tab/window/screen picker and obtains its one-use capture token.
- `scripting`: injects the content script into already-open AI tabs when no listener exists.
- `tabs`: reads URLs and last-access times to choose the supported destination and detect navigation.
- `storage`: stores options locally and temporary job metadata in session storage.
- `clipboardWrite`: writes a PNG when enabled or when automated attachment fails.
- Optional `downloads`: saves a PNG to Downloads/ShotToAI only when enabled; requested from the Options checkbox and removed when saving with the option disabled.
- Host access to `https://chatgpt.com/*`, `https://claude.ai/*`, `https://gemini.google.com/*`: runs adapters on these three sites only.
- `activeTab` is omitted because these explicit host grants already authorize injection; `offscreen` is omitted because the AI tab's content script handles the capture DOM APIs.

## Testing and results

Local tests: `node --test tests/core.test.cjs tests/worker.test.cjs tests/capture.test.cjs` (Node 22+). All 25 tests passed. JavaScript syntax checks passed. Regression tests assert no tab creation or navigation when capturing from an existing AI chat, correct picker target binding, cancellation/retry, concurrent trigger handling, navigation rejection, sender validation, track cleanup before encoding, downscaling, in-page cropping, and clipboard/download handling. Adapter fallback tests cover all three providers. These tests use mocked Chrome APIs and DOM objects, not live site sessions or real screen capture.

Headed-browser verification was attempted through the Computer Use/browser MCP. It discovered an open Google Chrome window titled ChatGPT. When binding that window, the tool stopped because it could not determine the current browser URL on Windows with enough confidence to enforce policy. It instructed that computer use must end for this turn. Therefore the extension was NOT loaded in the headed browser, no native capture was exercised, no live composer attachment or site console/DOM was verified, and ChatGPT, Claude, and Gemini live tests remain pending. Windows/macOS/Linux runtime behavior is not certified by these local tests.

Manual acceptance test, in order:

1. ChatGPT: start a fresh chat. Capture a harmless tab; verify exactly one image preview, the success toast, and an unsent composer. Repeat and verify two attachments with any typed text preserved.
2. Claude: repeat those steps in an authenticated chat.
3. Gemini: repeat those steps in an authenticated chat.
4. Open DevTools Console on each AI tab. Successful detection logs `ShotToAI: attachment preview detected (paste/file input/drop).` Inspect console errors and Elements; absence of a visible preview is a failure even if an event dispatched.
5. In `chrome://extensions`, inspect ShotToAI's **service worker** for worker errors. Inspect the AI tab for media/clipboard errors. Verify no extra capture tab is opened. No screenshot bytes are intentionally logged.
6. Cancel the picker; verify no attachment and no remaining sharing indicator, then trigger again directly from the same chat.
7. Enable crop, select a small region, and verify it attaches. Test reverse-direction dragging and reset. Verify the sharing indicator stopped before cropping.
8. Enable clipboard and paste into an image editor. Enable Downloads, grant its optional permission, and inspect the saved PNG dimensions after reducing max width.
9. Trigger from an unsupported site with an AI tab already open; verify routing to the most recent supported chat. Close all AI tabs and trigger again; verify the configured default opens.
10. Navigate to another conversation using the site's navigation while the crop preview is open; verify attachment is refused and the in-page Copy image recovery appears. Closing or fully reloading the tab discards its in-memory screenshot.

## Known limitations and troubleshooting

- **Privacy:** ShotToAI has no backend, telemetry, external dependencies, or external network requests. Capture/crop/encoding are local. However, attaching a screenshot to an AI website can immediately upload it to that website's servers before you send a chat message. Absolute "no data leaves the browser" is incompatible with a normal cloud AI attachment workflow.
- **Site UI changes:** inspect the composer, upload input, and newly visible attachment preview with DevTools. Update `ADAPTERS` at the top of `content.js`: `composer` is an ordered list of editable selectors; `inputs` lists real file inputs; `scope` identifies a composer ancestor containing its attachments; `evidence` identifies visible attachment previews/removal controls. Keep scope narrow enough to exclude earlier conversation images. Reload the extension and AI tabs, then retest all four routes. New hosts also require updating `shared.js`, the options selector, manifest host permissions, and content-script matches.
- **Synthetic events:** paste/drop events are untrusted, and some sites ignore them. File inputs may not exist until a site opens an upload menu. The extension does not click unknown upload menus or claim that a dispatched event proves attachment. Clipboard fallback is the supported escape path.
- **Slow uploads / duplicate images:** preview recognition is heuristic. A slow accepted upload might become visible after another fallback starts, producing duplicates. Check previews and remove an extra image before sending. An uncertain result is not automatically retried; clipboard instructions explicitly tell you to check first. A preview also does not prove the site's server finished processing it; wait for the site's upload status before sending.
- **Clipboard blocked:** click **Copy image** in the recovery overlay on the AI page, then close the overlay and paste with Ctrl+V or Command+V on Mac. If OS or enterprise policy blocks clipboard access, use the optional download and the site's normal uploader.
- **Login, upload limits, unsupported model/account:** sign in and use a chat that supports images. The extension cannot bypass provider limits. A newly opened default may land on a sign-in page; the capture remains available to copy.
- **Capture permission / black frame:** macOS may require Chrome's Screen Recording permission and restart. Linux/Wayland relies on the desktop screen-sharing portal. Protected/DRM surfaces may be black. These OS-specific behaviors were not tested here.
- **Target changed or closed:** navigation during the picker cancels capture. A conversation change while cropping refuses automatic attachment and offers in-page clipboard recovery. Full navigation, reload, or closing the tab destroys its in-memory screenshot. The extension never silently reroutes it to another conversation.
- **Very large PNG:** message payloads above roughly 24 MB of PNG bytes are rejected; reduce maximum width or crop. Extremely large sources can also exceed canvas/GPU memory limits. Width defaults to 1920 and is configurable from 320 to 7680; there is no upscaling.
- **Extension update:** click Reload on the extension card and refresh AI tabs to clear stale content scripts. Close any old version-1.0 capture tab; version 1.1 no longer uses it.
- **Shortcut does nothing:** assign a free shortcut in `chrome://extensions/shortcuts`; browser/OS shortcuts may conflict. The action icon remains available.
- **No offscreen document:** this is intentional. The token is scoped to the AI tab, and its content script owns capture and cropping without opening a separate page.

Only the three required providers are included; optional additional providers and features beyond the requested scope were not added.
