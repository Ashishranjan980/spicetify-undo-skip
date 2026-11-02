// Dependency-free smoke tests for undo-skip.js.
// Run with: node test/undo-skip.test.mjs
//
// The extension is loaded into a vm context with a fake Spicetify + DOM, so
// this exercises real event handling, the toast state machine, and the undo
// fallbacks without needing a running Spotify client.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, "../undo-skip.js"), "utf8");

const CTX = "spotify:playlist:context";
const OTHER_CTX = "spotify:album:other";

class FakeClassList {
    constructor() {
        this.set = new Set();
    }
    add(...names) {
        for (const name of names) this.set.add(name);
    }
    remove(...names) {
        for (const name of names) this.set.delete(name);
    }
    toggle(name, force) {
        if (force === undefined ? !this.set.has(name) : force) this.set.add(name);
        else this.set.delete(name);
    }
    contains(name) {
        return this.set.has(name);
    }
}

class FakeElement {
    constructor(tag = "div") {
        this.tagName = tag;
        this.id = "";
        this.style = {};
        this.classList = new FakeClassList();
        this.children = [];
        this.hidden = false;
        this.disabled = false;
        this.textContent = "";
        this.offsetWidth = 0;
        this._attrs = new Map();
        this._queries = new Map();
        this._listeners = new Map();
    }
    set innerHTML(value) {
        this._html = value;
    }
    get innerHTML() {
        return this._html;
    }
    querySelector(selector) {
        if (!this._queries.has(selector)) this._queries.set(selector, new FakeElement());
        return this._queries.get(selector);
    }
    append(...nodes) {
        this.children.push(...nodes);
    }
    addEventListener(type, callback) {
        if (!this._listeners.has(type)) this._listeners.set(type, []);
        this._listeners.get(type).push(callback);
    }
    click() {
        for (const callback of this._listeners.get("click") || []) callback({});
    }
    setAttribute(name, value) {
        this._attrs.set(name, value);
    }
    removeAttribute(name) {
        this._attrs.delete(name);
    }
}

function makeTrack(name, {
    uri = `spotify:track:${name.toLowerCase()}`,
    uid = `uid-${name.toLowerCase()}`,
    duration = 210000,
} = {}) {
    return {
        type: "track",
        uri,
        uid,
        name,
        duration: { milliseconds: duration },
        artists: [{ name: `${name} Artist` }],
        album: {
            images: [
                { url: "https://i.scdn.co/image/small", label: "small" },
                { url: "https://i.scdn.co/image/large", label: "large" },
            ],
        },
        metadata: {},
    };
}

function makePlayerState(track, {
    position = 0,
    context = CTX,
    index = 0,
    shuffle = false,
    paused = false,
} = {}) {
    return {
        item: track,
        context: { uri: context },
        index: { itemIndex: index },
        shuffle,
        isPaused: paused,
        positionAsOfTimestamp: position,
        duration: track.duration.milliseconds,
        timestamp: Date.now(),
    };
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeout = 4000, label = "condition") {
    const started = Date.now();
    while (Date.now() - started < timeout) {
        if (predicate()) return;
        await sleep(20);
    }
    assert.fail(`Timed out waiting for ${label}`);
}

function createHarness({ track, position = 100000, context = CTX, index = 0, paused = false }) {
    const events = new Map();
    const documentBody = new FakeElement("body");
    const documentHead = new FakeElement("head");
    const history = [];
    const app = {
        position,
        paused,
        playerState: null,
        current: track,
    };

    const player = {
        data: null,
        origin: {},
        addEventListener(type, callback) {
            events.set(type, callback);
        },
        getDuration() {
            return app.current.duration.milliseconds;
        },
        getProgress() {
            return app.position;
        },
        isPlaying() {
            return !app.paused;
        },
        seek(ms) {
            app.position = ms;
        },
        pause() {
            app.paused = true;
            if (player.data) player.data.isPaused = true;
        },
        play() {
            app.paused = false;
            if (player.data) player.data.isPaused = false;
        },
        back() {
            // Mirrors Spotify's previous button: restart the current track if
            // it is more than 3s in, otherwise move to the previous one.
            if (app.position > 3000) {
                app.position = 0;
                if (player.data) player.data.positionAsOfTimestamp = 0;
                return;
            }
            const previous = history.pop();
            if (!previous) return;
            app.current = previous.track;
            app.position = 0;
            app.paused = previous.paused;
            player.data = makePlayerState(previous.track, {
                position: 0,
                context: previous.context,
                index: previous.index,
                shuffle: false,
                paused: previous.paused,
            });
            dispatch("songchange", { data: player.data });
        },
        async playUri(uri, _context, options = {}) {
            const target = uri === CTX || uri === OTHER_CTX ? uri : uri;
            const record = history.find((entry) => entry.track.uri === target || entry.context === target);
            if (!record && uri !== app.current.uri) return;
            if (record) {
                app.current = record.track;
                app.position = options.seekTo || 0;
                player.data = makePlayerState(record.track, {
                    position: app.position,
                    context: record.context,
                    index: record.index,
                    paused: false,
                });
                dispatch("songchange", { data: player.data });
            }
        },
    };

    function dispatch(type, event) {
        const callback = events.get(type);
        if (callback) callback(event);
    }

    function setTrack(nextTrack, options = {}) {
        history.push({
            track: app.current,
            context: player.data?.context?.uri || CTX,
            index: player.data?.index?.itemIndex ?? 0,
            paused: app.paused,
        });
        app.current = nextTrack;
        app.position = options.position ?? 0;
        app.paused = options.paused ?? app.paused;
        player.data = makePlayerState(nextTrack, {
            position: app.position,
            context: options.context ?? CTX,
            index: options.index ?? 0,
            shuffle: options.shuffle ?? false,
            paused: app.paused,
        });
        dispatch("songchange", { data: player.data });
    }

    function snapshot() {
        dispatch("onprogress", app.position);
    }

    app.current = track;
    app.position = position;
    app.paused = paused;
    player.data = makePlayerState(track, { position, context, index, paused });

    const stored = new Map();
    let menuItem = null;
    const sandbox = {
        Spicetify: {
            Player: player,
            ReactJSX: { jsx: () => {} },
            LocalStorage: {
                get: (key) => stored.get(key) ?? null,
                set: (key, value) => stored.set(key, value),
            },
            Keyboard: {
                KEYS: { Z: "z" },
                registerShortcut: (_keys, _callback) => {},
            },
            Menu: {
                Item: class {
                    constructor(name, state, onClick, icon) {
                        this.name = name;
                        this.state = state;
                        this.onClick = onClick;
                        this.icon = icon;
                        this.registered = false;
                    }
                    setState(state) {
                        this.state = state;
                    }
                    register() {
                        this.registered = true;
                        menuItem = this;
                    }
                },
            },
            Platform: {
                PlayerAPI: {
                    async play() {},
                },
            },
        },
        document: {
            body: documentBody,
            head: documentHead,
            createElement: (tag) => new FakeElement(tag),
            getElementById: () => null,
        },
        window: {},
        console,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        Date,
        Math,
    };

    vm.runInNewContext(source, sandbox, { filename: "undo-skip.js" });
    snapshot();

    return {
        app,
        events,
        player,
        menuItem: () => menuItem,
        setTrack,
        snapshot,
        dispatch,
        toast() {
            return documentBody.children.find((child) => child.tagName === "div" && child._html);
        },
        // The toast root is created via createElement, so find it by id attr.
        toastRoot() {
            return documentBody.children.find((child) => child.id === "undo-skip-toast");
        },
        storage: stored,
    };
}

const A = makeTrack("A");
const B = makeTrack("B");

async function testManualSkipShowsUndoAndRestoresPosition() {
    const h = createHarness({ track: A, position: 100000 });
    h.setTrack(B, { position: 0, index: 1 });

    const toast = h.toastRoot();
    assert.ok(toast, "toast root should exist");
    assert.ok(toast.classList.contains("is-visible"), "toast should be visible");
    assert.equal(toast.querySelector(".undo-skip-kicker").textContent, "Skipped");
    assert.equal(toast.querySelector(".undo-skip-name").textContent, "A");
    assert.equal(toast.querySelector(".undo-skip-artist").textContent, "A Artist");

    toast.querySelector(".undo-skip-btn").click();

    await waitFor(
        () => h.player.data?.item?.uri === A.uri && h.app.position === 100000,
        4000,
        "restore to A at 100s",
    );
    await waitFor(
        () => h.toastRoot().querySelector(".undo-skip-kicker").textContent === "Back to",
        4000,
        "restored toast",
    );

    const result = h.toastRoot();
    assert.equal(result.querySelector(".undo-skip-name").textContent, "A");
}

async function testNaturalEndDoesNotShowToast() {
    const h = createHarness({ track: A, position: 209000 });
    h.snapshot();
    h.setTrack(B, { position: 0, index: 1 });

    const toast = h.toastRoot();
    assert.ok(!toast?.classList.contains("is-visible"), "natural transition must not show a toast");
}

async function testContextChangeDoesNotShowToast() {
    const h = createHarness({ track: A, position: 100000 });
    h.setTrack(B, { position: 0, index: 1, context: OTHER_CTX });

    const toast = h.toastRoot();
    assert.ok(!toast?.classList.contains("is-visible"), "context change must not show a toast");
}

async function testBackwardsNavigationDoesNotShowToast() {
    const h = createHarness({ track: A, position: 100000, index: 3 });
    h.setTrack(B, { position: 100000, index: 2 });

    const toast = h.toastRoot();
    assert.ok(!toast?.classList.contains("is-visible"), "clicking an earlier row must not show a toast");
}

async function testPausedSkipRestoresPauseState() {
    const h = createHarness({ track: A, position: 50000, paused: true });
    h.setTrack(B, { position: 0, paused: true, index: 1 });

    const toast = h.toastRoot();
    assert.ok(toast.classList.contains("is-visible"), "paused skip should still offer undo");

    toast.querySelector(".undo-skip-btn").click();

    await waitFor(
        () => h.player.data?.item?.uri === A.uri && h.app.position === 50000,
        4000,
        "restore to A at 50s",
    );
    await waitFor(
        () => h.toastRoot().querySelector(".undo-skip-kicker").textContent === "Back to",
        4000,
        "restored toast",
    );
    assert.equal(h.app.paused, true, "restored track should stay paused");
}

async function testSpotifyImageUriIsNormalized() {
    const track = makeTrack("C");
    track.album.images = [{ url: "spotify:image:abc123" }];

    const h = createHarness({ track, position: 20000 });
    h.setTrack(B, { position: 0, index: 1 });

    const toast = h.toastRoot();
    assert.ok(toast.classList.contains("is-visible"), "toast should be visible");
    assert.equal(
        toast.querySelector(".undo-skip-art").src,
        "https://i.scdn.co/image/abc123",
        "spotify:image URIs should become CDN URLs",
    );
}

async function testMenuTogglePersists() {
    const h = createHarness({ track: A, position: 100000 });
    const item = h.menuItem();
    assert.ok(item?.registered, "profile menu item should register");
    assert.equal(item.state, true);

    item.onClick(item);
    assert.equal(item.state, false);
    assert.equal(h.storage.get("undo-skip:enabled"), "false");
}

const tests = [
    testManualSkipShowsUndoAndRestoresPosition,
    testNaturalEndDoesNotShowToast,
    testContextChangeDoesNotShowToast,
    testBackwardsNavigationDoesNotShowToast,
    testPausedSkipRestoresPauseState,
    testSpotifyImageUriIsNormalized,
    testMenuTogglePersists,
];

let failed = 0;
for (const test of tests) {
    try {
        await test();
        console.log(`ok   ${test.name}`);
    } catch (error) {
        failed++;
        console.error(`fail ${test.name}`);
        console.error(error);
    }
}

process.exit(failed === 0 ? 0 : 1);
