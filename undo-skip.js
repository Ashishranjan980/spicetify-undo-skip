// Undo Skip - Spicetify Extension
//
// Shows a toast after an accidental track change with an Undo action that
// returns to the previous track at the exact position it was left at.
//
// Why the rolling snapshot:
//   `songchange` fires *after* Spotify has switched its state to the new
//   track, so by the time the event arrives the old position is gone. We
//   therefore keep our own last-known snapshot of the current track, sampled
//   from `onprogress` (every 100ms while playing), `onplaypause`, and a slow
//   interval for paused playback.
//
// Skip detection:
//   - same playback context (a different playlist/album is a navigation, not
//     a skip)
//   - not within the last 12s of the track (also covers Spotify's max 12s
//     crossfade, where a natural transition happens before `duration`)
//   - never for ads
//   - no toast when going backwards / clicking an earlier track

(function undoSkip() {
    if (!Spicetify?.Player?.addEventListener) {
        setTimeout(undoSkip, 300);
        return;
    }

    // Spicetify's wrapper replaces `Spicetify.Player` asynchronously once it
    // has resolved its webpack modules. The replacement is the object that
    // owns the live `origin` getter (PlayerAPI); the pre-replacement object
    // never receives events. Wait for the final object instead of capturing
    // a reference that goes stale moments later.
    if (!Spicetify.Player.origin || !Spicetify.Platform?.PlayerAPI) {
        setTimeout(undoSkip, 100);
        return;
    }

    const STORAGE_KEY = "undo-skip:enabled";
    const TOAST_ID = "undo-skip-toast";
    const TOAST_MS = 7000;
    const UNDO_WINDOW_MS = 30000;
    const NEAR_END_MS = 12000;
    const SAMPLE_MS = 400;

    const { Player } = Spicetify;

    let enabled = Spicetify.LocalStorage?.get(STORAGE_KEY) !== "false";
    let last = null;            // rolling snapshot of the playing track
    let pending = null;         // { record, skippedAt } waiting for undo
    let restoring = false;      // an undo is in flight
    let suppressUntil = 0;      // ignore songchange events caused by undo
    let toast = null;

    // ---------------------------------------------------------------- state

    function snapshot() {
        const d = Player.data;
        if (!d?.item?.uri) return;

        let duration = 0;
        let rawPosition = 0;
        try {
            duration = d.item.duration?.milliseconds || Player.getDuration() || 0;
            rawPosition = Player.getProgress();
        } catch {}

        last = {
            uri: d.item.uri,
            uid: d.item.uid || "",
            name: d.item.name || "",
            artist: (d.item.artists || []).map((a) => a.name).filter(Boolean).join(", "),
            image: pickImage(d.item),
            duration,
            position: Number.isFinite(rawPosition)
                ? Math.max(0, duration > 0 ? Math.min(rawPosition, duration) : rawPosition)
                : 0,
            contextUri: d.context?.uri || "",
            index: d.index?.itemIndex ?? null,
            shuffle: !!d.shuffle,
            paused: !!d.isPaused,
            at: Date.now(),
        };
    }

    function pickImage(item) {
        const candidates = [
            ...(item.album?.images || []),
            ...(item.images || []),
        ];

        const url = candidates.find((img) => typeof img?.url === "string" && img.url)?.url
            || item.metadata?.image_url
            || "";

        return /^https?:\/\//.test(url) ? url : "";
    }

    function isAd(uri) {
        return typeof uri === "string" && uri.includes(":ad:");
    }

    function isForwardSkip(prev, next) {
        if (!prev?.uri || !next?.item?.uri) return false;
        if (prev.uri === next.item.uri) return false;
        if (isAd(prev.uri) || isAd(next.item.uri)) return false;

        // A different context means the user deliberately started something
        // else; there is nothing meaningful to "undo".
        const nextContext = next.context?.uri || "";
        if (prev.contextUri && nextContext && prev.contextUri !== nextContext) return false;

        // Clicking an earlier row in the same playlist is a navigation, not a
        // skip. Shuffle makes itemIndex non-monotonic, so only apply this when
        // shuffle is off.
        const nextIndex = next.index?.itemIndex;
        if (
            !prev.shuffle
            && !next.shuffle
            && prev.index != null
            && nextIndex != null
            && nextIndex < prev.index
        ) {
            return false;
        }

        // Natural end (including crossfade): the snapshot is up to SAMPLE_MS
        // old, so project the position forward a little before comparing.
        // 12s is Spotify's maximum crossfade, but don't let that swallow most
        // of a very short track.
        if (prev.duration > 0) {
            const window = Math.min(NEAR_END_MS, Math.max(3000, prev.duration * 0.15));
            const elapsed = prev.paused ? 0 : Math.min(Math.max(0, Date.now() - prev.at), 2000);
            if (prev.position + elapsed >= prev.duration - window) return false;
        }

        return true;
    }

    // ------------------------------------------------------------ detection

    function onSongChange(event) {
        const prev = last;
        const next = event?.data || Player.data;

        // Re-snapshot immediately so the next event compares against the new
        // track, not against a stale one.
        snapshot();

        if (!next?.item?.uri) return;
        if (restoring || Date.now() < suppressUntil) return;
        if (!prev || prev.uri === next.item.uri) return;

        if (!enabled || !isForwardSkip(prev, next)) {
            clearPending();
            return;
        }

        pending = { record: prev, skippedAt: Date.now() };
        showToast(prev, "skip");
    }

    // ---------------------------------------------------------------- undo

    async function undo() {
        if (!pending || restoring) return;

        const { record, skippedAt } = pending;
        pending = null;

        if (Date.now() - skippedAt > UNDO_WINDOW_MS) {
            hideToast();
            return;
        }

        restoring = true;
        suppressUntil = Date.now() + 8000;
        showToast(record, "restoring");

        let ok = false;
        try {
            ok = await restore(record);
        } catch (error) {
            console.warn("[undo-skip] restore failed:", error);
        }

        restoring = false;
        // Give late songchange events from the restore a moment to settle.
        suppressUntil = Date.now() + 1500;

        showToast(record, ok ? "restored" : "failed");
    }

    async function restore(rec) {
        const before = Player.data?.item?.uri;

        // 1. Walk Spotify's own history first: this keeps the current queue
        //    and context intact. `back()` may either move to the previous
        //    track or restart the current one (if it is >3s in), so detect
        //    which happened and press again if needed.
        if (before && before !== rec.uri) {
            try {
                Player.back();
            } catch {}

            const moved = await waitUntil(() => Player.data?.item?.uri !== before, 1200);
            if (!moved) {
                try {
                    Player.back();
                } catch {}
            }

            await waitUntil(() => Player.data?.item?.uri === rec.uri, 1800);
            if (Player.data?.item?.uri === rec.uri) {
                await seekTo(rec);
                await restorePause(rec);
                return true;
            }
        } else if (before === rec.uri) {
            await seekTo(rec);
            await restorePause(rec);
            return true;
        }

        // 2. Jump inside the original context by uid. This keeps the skipped
        //    track's neighbours available, unlike playing a bare track URI.
        if (rec.contextUri && rec.uid) {
            try {
                await Player.playUri(
                    rec.contextUri,
                    {},
                    {
                        skipTo: { uri: rec.uri, uid: rec.uid },
                        seekTo: Math.max(0, Math.floor(rec.position)),
                    }
                );
            } catch {}

            if (await waitUntil(() => Player.data?.item?.uri === rec.uri, 2500)) {
                await seekTo(rec);
                await restorePause(rec);
                return true;
            }
        }

        // 3. Last resort: play the track on its own. The queue is lost, but
        //    the user at least gets the track and position back.
        try {
            await Player.playUri(rec.uri, {}, { seekTo: Math.max(0, Math.floor(rec.position)) });
        } catch {}

        if (await waitUntil(() => Player.data?.item?.uri === rec.uri, 2500)) {
            await seekTo(rec);
            await restorePause(rec);
            return true;
        }

        // 4. Some client versions prefer the modern PlayerAPI shape.
        try {
            await Spicetify.Platform?.PlayerAPI?.play(
                { uri: rec.uri },
                {},
                { positionMs: Math.max(0, Math.floor(rec.position)) }
            );
        } catch {}

        if (await waitUntil(() => Player.data?.item?.uri === rec.uri, 2500)) {
            await seekTo(rec);
            await restorePause(rec);
            return true;
        }

        return false;
    }

    async function seekTo(rec) {
        const target = Math.max(0, Math.floor(rec.position));
        if (target < 750) return true;

        // The player occasionally ignores a seek issued while the next track
        // is still loading, so retry with increasing backoff.
        for (let attempt = 0; attempt < 6; attempt++) {
            try {
                Player.seek(target);
            } catch {}

            await sleep(220 + attempt * 80);

            try {
                if (Math.abs(Player.getProgress() - target) <= 2000) return true;
            } catch {}
        }

        return false;
    }

    async function restorePause(rec) {
        if (!rec.paused) return;
        await sleep(120);
        try {
            if (Player.isPlaying()) Player.pause();
        } catch {}
    }

    function waitUntil(predicate, timeout) {
        return new Promise((resolve) => {
            const started = Date.now();

            const tick = () => {
                let ok = false;
                try {
                    ok = !!predicate();
                } catch {}

                if (ok) return resolve(true);
                if (Date.now() - started >= timeout) return resolve(false);
                setTimeout(tick, 100);
            };

            tick();
        });
    }

    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    // --------------------------------------------------------------- toast

    function ensureToast() {
        if (toast) return toast;
        if (!document.body) return null;

        if (!document.getElementById("undo-skip-styles")) {
            const style = document.createElement("style");
            style.id = "undo-skip-styles";
            style.textContent = TOAST_CSS;
            document.head?.append(style);
        }

        const root = document.createElement("div");
        root.id = TOAST_ID;
        root.setAttribute("role", "status");
        root.setAttribute("aria-live", "polite");
        root.setAttribute("aria-hidden", "true");
        root.innerHTML = `
            <div class="undo-skip-card">
                <img class="undo-skip-art" alt="" decoding="async" />
                <div class="undo-skip-text">
                    <div class="undo-skip-kicker"></div>
                    <div class="undo-skip-name"></div>
                    <div class="undo-skip-artist"></div>
                </div>
                <button class="undo-skip-btn" type="button">Undo</button>
                <div class="undo-skip-life"><div class="undo-skip-life-bar"></div></div>
            </div>
        `;

        document.body.append(root);

        const btn = root.querySelector(".undo-skip-btn");
        btn?.addEventListener("click", () => {
            void undo();
        });

        toast = {
            root,
            art: root.querySelector(".undo-skip-art"),
            kicker: root.querySelector(".undo-skip-kicker"),
            name: root.querySelector(".undo-skip-name"),
            artist: root.querySelector(".undo-skip-artist"),
            btn,
            life: root.querySelector(".undo-skip-life"),
            lifeBar: root.querySelector(".undo-skip-life-bar"),
            hideTimer: 0,
            mode: null,
        };

        return toast;
    }

    function showToast(rec, mode) {
        const t = ensureToast();
        if (!t) return;

        clearTimeout(t.hideTimer);
        t.hideTimer = 0;
        t.mode = mode;

        t.root.classList.toggle("is-error", mode === "failed");
        t.root.classList.add("is-visible");
        t.root.setAttribute("aria-hidden", "false");

        if (rec.image) {
            t.art.src = rec.image;
            t.art.style.visibility = "visible";
        } else {
            t.art.removeAttribute("src");
            t.art.style.visibility = "hidden";
        }

        t.name.textContent = rec.name || "Unknown track";
        t.artist.textContent = rec.artist || "";
        t.artist.hidden = !rec.artist;

        t.btn.hidden = mode !== "skip";
        t.btn.disabled = false;
        t.life.hidden = mode !== "skip";

        if (mode === "skip") {
            t.kicker.textContent = "Skipped";
            t.btn.textContent = "Undo";

            // Restart the drain animation from full.
            t.lifeBar.style.animation = "none";
            void t.lifeBar.offsetWidth;
            t.lifeBar.style.animation = "";

            t.hideTimer = setTimeout(hideToast, TOAST_MS);
        } else if (mode === "restoring") {
            t.kicker.textContent = "Going back";
        } else if (mode === "restored") {
            t.kicker.textContent = "Back to";
            t.hideTimer = setTimeout(hideToast, 2800);
        } else {
            t.kicker.textContent = "Couldn't go back";
            t.artist.textContent = "The track may no longer be available";
            t.artist.hidden = false;
            t.hideTimer = setTimeout(hideToast, 4200);
        }
    }

    function hideToast() {
        if (!toast) return;
        clearTimeout(toast.hideTimer);
        toast.hideTimer = 0;
        toast.root.classList.remove("is-visible");
        toast.root.setAttribute("aria-hidden", "true");
    }

    function clearPending() {
        pending = null;
        if (toast?.mode === "skip") hideToast();
    }

    // ------------------------------------------------------------- lifecycle

    snapshot();
    setInterval(snapshot, SAMPLE_MS);
    Player.addEventListener("onprogress", snapshot);
    Player.addEventListener("onplaypause", snapshot);
    Player.addEventListener("songchange", onSongChange);

    // Shortcut stays useful after the toast has drained. Keyboard bindings are
    // installed asynchronously, and the wrapper can replace `Spicetify.Mousetrap`
    // during startup (which drops earlier binds), so re-bind if ours disappears.
    function ensureShortcut() {
        if (!Spicetify.Keyboard?.registerShortcut || !Spicetify.Keyboard.KEYS?.Z) return;
        if (!Spicetify.Mousetrap?.trigger) return;

        try {
            const bound = Object.keys(Spicetify.Mousetrap.trigger()._directMap || {})
                .some((key) => key.startsWith("mod+shift+z"));
            if (bound) return;

            Spicetify.Keyboard.registerShortcut(
                { key: Spicetify.Keyboard.KEYS.Z, ctrl: true, shift: true },
                () => {
                    if (pending) void undo();
                }
            );
        } catch (error) {
            console.warn("[undo-skip] could not register shortcut:", error);
        }
    }

    setInterval(ensureShortcut, 4000);
    ensureShortcut();

    // Small, intentionally undocumented surface for development/debugging.
    const debug = {
        item: null,
        state: () => ({
            enabled,
            restoring,
            suppressUntil,
            pending: pending
                ? { uri: pending.record.uri, position: Math.round(pending.record.position) }
                : null,
            last: last ? { uri: last.uri, position: Math.round(last.position), index: last.index } : null,
            toastMode: toast?.mode ?? null,
        }),
        snapshot,
        isForwardSkip,
    };
    window.__undoSkip = debug;

    // The profile-menu item is built with Spotify's JSX runtime, which is not
    // guaranteed to be bound when extensions first run. Poll for it instead of
    // throwing away the toggle.
    function registerMenu(attempt = 0) {
        if (!Spicetify.ReactJSX?.jsx || !Spicetify.Menu?.Item) {
            if (attempt < 40) setTimeout(() => registerMenu(attempt + 1), 250);
            return;
        }

        try {
            const item = new Spicetify.Menu.Item("Undo skip toast", enabled, (self) => {
                enabled = !enabled;
                self.setState(enabled);
                Spicetify.LocalStorage?.set(STORAGE_KEY, String(enabled));
                if (!enabled) clearPending();
            });
            item.register();
            debug.item = item;
        } catch (error) {
            console.warn("[undo-skip] could not register menu item:", error);
        }
    }

    registerMenu();

    // ---------------------------------------------------------------- styles

    const TOAST_CSS = `
        #${TOAST_ID} {
            --undo-bg: var(--spice-card, var(--background-elevated-base, #282828));
            --undo-text: var(--spice-text, var(--text-base, #ffffff));
            --undo-sub: var(--spice-subtext, var(--text-subdued, #b3b3b3));
            --undo-accent: var(--spice-button, var(--text-bright-accent, #1ed760));
            --undo-life: ${TOAST_MS}ms;

            position: fixed;
            left: 50%;
            bottom: 96px;
            z-index: 2147483000;
            width: max-content;
            max-width: calc(100vw - 32px);
            transform: translate(-50%, 14px);
            opacity: 0;
            pointer-events: none;
            transition: opacity 0.16s ease, transform 0.2s cubic-bezier(0.22, 0.8, 0.24, 1);
            font-family: var(--font-family, "Circular Std", "Segoe UI", system-ui, sans-serif);
            -webkit-font-smoothing: antialiased;
        }

        #${TOAST_ID}.is-visible {
            opacity: 1;
            transform: translate(-50%, 0);
            pointer-events: auto;
        }

        #${TOAST_ID} .undo-skip-card {
            position: relative;
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 10px;
            border-radius: 12px;
            overflow: hidden;
            color: var(--undo-text);
            background: var(--undo-bg);
            border: 1px solid rgba(255, 255, 255, 0.1);
            box-shadow: 0 16px 40px rgba(0, 0, 0, 0.55), 0 2px 8px rgba(0, 0, 0, 0.35);
        }

        #${TOAST_ID}.is-error .undo-skip-card {
            border-color: rgba(243, 114, 114, 0.45);
        }

        #${TOAST_ID} .undo-skip-art {
            flex: 0 0 auto;
            width: 42px;
            height: 42px;
            border-radius: 7px;
            object-fit: cover;
            background: rgba(255, 255, 255, 0.08);
        }

        #${TOAST_ID} .undo-skip-text {
            display: flex;
            flex-direction: column;
            min-width: 0;
            max-width: 280px;
            padding-right: 4px;
        }

        #${TOAST_ID} .undo-skip-kicker {
            font-size: 10px;
            font-weight: 700;
            letter-spacing: 0.09em;
            line-height: 1.5;
            text-transform: uppercase;
            color: var(--undo-sub);
        }

        #${TOAST_ID}.is-error .undo-skip-kicker {
            color: #f37272;
        }

        #${TOAST_ID} .undo-skip-name {
            font-size: 14px;
            font-weight: 600;
            line-height: 1.35;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        #${TOAST_ID} .undo-skip-artist {
            font-size: 12px;
            line-height: 1.35;
            color: var(--undo-sub);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        #${TOAST_ID} .undo-skip-artist[hidden] {
            display: none;
        }

        #${TOAST_ID} .undo-skip-btn {
            flex: 0 0 auto;
            padding: 8px 10px;
            border: 0;
            border-radius: 999px;
            background: transparent;
            color: var(--undo-accent);
            font: inherit;
            font-size: 12px;
            font-weight: 700;
            letter-spacing: 0.06em;
            text-transform: uppercase;
            cursor: pointer;
        }

        #${TOAST_ID} .undo-skip-btn:hover {
            background: rgba(255, 255, 255, 0.08);
        }

        #${TOAST_ID} .undo-skip-btn:focus-visible {
            outline: 2px solid var(--undo-accent);
            outline-offset: 2px;
        }

        #${TOAST_ID} .undo-skip-btn[hidden] {
            display: none;
        }

        #${TOAST_ID} .undo-skip-life {
            position: absolute;
            left: 0;
            right: 0;
            bottom: 0;
            height: 2px;
            background: rgba(255, 255, 255, 0.1);
        }

        #${TOAST_ID} .undo-skip-life[hidden] {
            display: none;
        }

        #${TOAST_ID} .undo-skip-life-bar {
            width: 100%;
            height: 100%;
            background: var(--undo-accent);
            transform-origin: left center;
            animation: undo-skip-drain var(--undo-life) linear forwards;
        }

        @keyframes undo-skip-drain {
            from { transform: scaleX(1); }
            to { transform: scaleX(0); }
        }

        @media (prefers-reduced-motion: reduce) {
            #${TOAST_ID} {
                transition: none;
            }
            #${TOAST_ID} .undo-skip-life-bar {
                animation: none;
            }
        }
    `;
})();
