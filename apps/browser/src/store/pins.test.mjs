// Pinned tabs are the profile's, in every window (store/pinMirror.ts): losing or doubling them is data loss.
import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("./browser.ts");
const model = await import("./model.ts");

const S = () => useBrowser.getState();
const reset = () => S().hydrate({});

// The window's pinned section: tiles, then `Group/` members; `*` marks a copy with a page.
const sidebar = (w) =>
  model.viewTabIds(S(), w).filter((id) => model.inPinnedContainer(S(), id)).map((id) => {
    const t = S().tabs[id];
    const g = Object.values(S().groups).find((g) => g.tabIds.includes(id));
    return `${g ? `${g.name}/` : ""}${t.customTitle ?? t.url}${t.unloaded ? "" : "*"}`;
  });
const regular = (w) => model.viewTabIds(S(), w).filter((id) => !model.inPinnedContainer(S(), id)).map((id) => S().tabs[id].url);
const tabAt = (w, url) => model.viewTabIds(S(), w).find((id) => S().tabs[id].url === url || S().tabs[id].pinnedUrl === url);

function pinnedWindow() {
  const w = S().createWindow({ url: "mail.com" });
  const [mail] = S().windows[w].tabIds;
  const docs = S().newTab(w, { url: "docs.com" });
  const jira = S().newTab(w, { url: "jira.com" });
  const a = S().newTab(w, { url: "a.com" });
  S().pinTabs([mail, docs], true);
  const work = S().groupTabs([jira], { pinned: true, name: "Work" });
  S().activate(a);
  return { w, mail, docs, jira, work, a };
}
const PINS = ["https://mail.com", "https://docs.com", "Work/https://jira.com"];

test("⌘N with a window open: the new window has the profile's pins, unloaded, its own copies", () => {
  reset();
  const { w, mail, work } = pinnedWindow();
  const n = S().createWindow();
  assert.deepEqual(sidebar(n), PINS);
  assert.deepEqual(sidebar(w), ["https://mail.com*", "https://docs.com*", "Work/https://jira.com*"], "the first window's pages stay");
  const copy = S().tabs[tabAt(n, "https://mail.com")];
  assert.notEqual(copy.id, mail, "its own tab");
  assert.equal(copy.pinKey, S().tabs[mail].pinKey, "the same pin");
  assert.equal(copy.pinnedUrl, "https://mail.com");
  const group = Object.values(S().groups).find((g) => g.windowId === n && g.pinned);
  assert.equal(group.pinKey, S().groups[work].pinKey);
  assert.deepEqual(regular(n), [""], "a New Tab page is shown");
  const priv = S().createWindow({ incognito: true });
  assert.deepEqual(sidebar(priv), [], "a private window has none");
});

test("pin, unpin, reorder, rename, icon and pinned URL in one window reach the other", () => {
  reset();
  const { w, docs, a } = pinnedWindow();
  const n = S().createWindow();
  S().pinTabs([a], true);
  assert.deepEqual(sidebar(n), ["https://mail.com", "https://docs.com", "https://a.com", "Work/https://jira.com"], "pinned: a copy at the same place");
  S().moveTab(a, 0);
  assert.deepEqual(sidebar(n).slice(0, 3), ["https://a.com", "https://mail.com", "https://docs.com"], "reordered");
  const nDocs = tabAt(n, "https://docs.com");
  S().updateTab(nDocs, { customTitle: "Docs", customIcon: "doc" });
  assert.equal(S().tabs[docs].customTitle, "Docs", "renamed in the other window");
  assert.equal(S().tabs[docs].customIcon, "doc");
  S().setPinnedUrl(docs, "https://docs.com/home");
  assert.equal(S().tabs[nDocs].pinnedUrl, "https://docs.com/home");
  assert.equal(S().tabs[nDocs].url, "https://docs.com/home", "an unloaded copy follows its pin");
  S().pinTabs([a], false);
  assert.deepEqual(sidebar(n), ["https://mail.com", "Docs", "Work/https://jira.com"], "unpinned: its unloaded copy goes");
  assert.deepEqual(regular(w), ["https://a.com"], "and stays a tab where it was unpinned");
});

test("navigating and ⌘W stay in their window; unpinning keeps a page the other window shows", () => {
  reset();
  const { w, mail } = pinnedWindow();
  const n = S().createWindow();
  const nMail = tabAt(n, "https://mail.com");
  S().activate(nMail);
  S().navigated(nMail, { url: "https://mail.com/inbox/1", title: "Message" }, {});
  assert.equal(S().tabs[mail].url, "https://mail.com", "not mirrored");
  S().closeTab(mail);
  assert.equal(S().tabs[mail].unloaded, true);
  assert.equal(S().tabs[nMail].unloaded, undefined, "the other window's page is still open");
  S().pinTabs([mail], false);
  assert.equal(S().tabs[nMail]?.pinned, false, "the copy showing a page isn't closed");
  assert.equal(S().tabs[nMail].url, "https://mail.com/inbox/1");
  assert.equal(S().tabs[nMail].pinKey, undefined);
  assert.deepEqual(regular(n), ["https://mail.com/inbox/1", ""]);
  assert.deepEqual(sidebar(n), ["https://docs.com", "Work/https://jira.com"]);
});

test("pinned groups: rename, colour, members added and removed, delete", () => {
  reset();
  const { w, work, a } = pinnedWindow();
  const n = S().createWindow();
  const copy = () => Object.values(S().groups).find((g) => g.windowId === n && g.pinned);
  S().updateGroup(work, { name: "Jobs", color: "blue" });
  assert.equal(copy().name, "Jobs");
  assert.equal(copy().color, "blue");
  S().placeTabs([a], { pinned: false, groupId: work });
  assert.deepEqual(sidebar(n), ["https://mail.com", "https://docs.com", "Jobs/https://jira.com", "Jobs/https://a.com"]);
  S().placeTabs([a], { pinned: false, beforeId: null });
  assert.deepEqual(sidebar(n), ["https://mail.com", "https://docs.com", "Jobs/https://jira.com"]);
  S().placeTabs([a], { pinned: true, beforeId: null });
  assert.deepEqual(sidebar(n), ["https://mail.com", "https://docs.com", "https://a.com", "Jobs/https://jira.com"], "dragged into the pinned area");
  S().deleteGroup(copy().id);
  assert.deepEqual(sidebar(w), ["https://mail.com*", "https://docs.com*", "https://a.com*"], "deleted in the other window: gone here");
  assert.deepEqual(regular(w), ["https://jira.com"], "its page here stays, as a tab");
});

test("closing one of two windows parks nothing; closing the last parks once, for the next window", () => {
  reset();
  const { w } = pinnedWindow();
  const n = S().createWindow();
  S().closeWindow(w);
  assert.deepEqual(S().parkedPins, {}, "the other window has them");
  assert.deepEqual(sidebar(n), PINS);
  S().closeWindow(n);
  assert.equal(S().parkedPins.default.tabs.length, 3);
  const m = S().createWindow();
  assert.deepEqual(sidebar(m), PINS);
  assert.deepEqual(S().parkedPins, {});
  assert.deepEqual(sidebar(S().createWindow()), PINS);
});

test("⇧⌘T of a pinned page whose window closed restores it into the pin's copy, not a second pin", () => {
  reset();
  const { w, mail } = pinnedWindow();
  const n = S().createWindow();
  S().closeTab(mail);
  S().closeWindow(w);
  S().reopenClosedTab(n);
  assert.deepEqual(sidebar(n), ["https://mail.com*", "https://docs.com", "Work/https://jira.com"]);
  assert.equal(S().tabs[tabAt(n, "https://mail.com")].adoptId, `restore:${mail}`, "with its back/forward list");
});

test("moving or dragging a pinned tab to another window: it takes its copy's place, its window keeps a copy", () => {
  reset();
  const { w, mail } = pinnedWindow();
  const n = S().createWindow();
  S().moveTabsToWindow([mail], n);
  assert.equal(S().tabs[mail].windowId, n);
  assert.deepEqual(sidebar(n), ["https://mail.com*", "https://docs.com", "Work/https://jira.com"], "no second mail.com");
  assert.deepEqual(sidebar(w), ["https://mail.com", "https://docs.com*", "Work/https://jira.com*"], "an unloaded copy stays behind");
  const out = S().createWindow({ tabIds: [tabAt(w, "https://docs.com")] });
  assert.deepEqual(sidebar(out), ["https://mail.com", "https://docs.com*", "Work/https://jira.com"], "a new window from a dragged pin");
  assert.deepEqual(sidebar(w), ["https://mail.com", "https://docs.com", "Work/https://jira.com*"]);
});

test("Merge All Windows: one set of pins, every page kept", () => {
  reset();
  const { w } = pinnedWindow();
  const n = S().createWindow();
  const nDocs = tabAt(n, "https://docs.com");
  S().activate(nDocs);
  S().navigated(nDocs, { url: "https://docs.com/page", title: "Page" }, {});
  S().activate(tabAt(n, "https://jira.com"));
  S().mergeAllWindows(w);
  assert.deepEqual(Object.keys(S().windows), [w]);
  assert.deepEqual(sidebar(w), ["https://mail.com*", "https://docs.com*", "Work/https://jira.com*"]);
  assert.equal(Object.values(S().groups).filter((g) => g.pinned).length, 1, "one pinned group");
  assert.deepEqual(regular(w).sort(), ["", "https://a.com", "https://docs.com/page", "https://jira.com"], "the other window's open pages stay, as tabs");
});

test("a session saved before pins were shared: windows get the union, one pin per page", () => {
  reset();
  const tab = (id, windowId, url, extra = {}) => ({
    id, windowId, profileId: "default", url, title: "", favicon: null, pinned: false, muted: false, zoom: 1, customTitle: null,
    customIcon: null, pinnedUrl: null, navigation: null, openerId: null, createdAt: 0, lastActiveAt: 0, ...extra,
  });
  const win = (id, tabIds) => ({ id, profileId: "default", incognito: false, tabIds, activeTabIds: { default: tabIds.at(-1) }, sidebarOpen: true, frame: null, createdAt: 0 });
  S().hydrate({
    profiles: { default: { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 } },
    windows: { w1: win("w1", ["m1", "x1", "r1"]), w2: win("w2", ["m2", "y2", "j2", "r2"]) },
    windowOrder: ["w1", "w2"],
    tabs: {
      m1: tab("m1", "w1", "https://mail.com", { pinned: true }),
      x1: tab("x1", "w1", "https://x.com", { pinned: true }),
      r1: tab("r1", "w1", "https://r1.com"),
      m2: tab("m2", "w2", "https://mail.com/", { pinned: true, unloaded: true }),
      y2: tab("y2", "w2", "https://y.com", { pinned: true }),
      j2: tab("j2", "w2", "https://jira.com"),
      r2: tab("r2", "w2", "https://r2.com"),
    },
    groups: { g: { id: "g", windowId: "w2", profileId: "default", name: "Work", icon: null, color: null, collapsed: false, pinned: true, tabIds: ["j2"], createdAt: 0 } },
    parkedPins: { default: { tabs: [{ url: "https://z.com", title: "", favicon: null, pinned: true, muted: false, zoom: 1, customTitle: null, customIcon: null, pinnedUrl: "https://z.com", profileId: "default", id: "z", groupId: null }], groups: [] } },
  });
  const pins = (w) => sidebar(w).map((p) => p.replace("*", ""));
  assert.deepEqual(pins("w1"), ["https://z.com", "https://mail.com", "https://x.com", "https://y.com", "Work/https://jira.com"]);
  assert.deepEqual(pins("w2"), ["https://z.com", "https://mail.com/", "https://x.com", "https://y.com", "Work/https://jira.com"]);
  assert.equal(S().tabs.m2.pinKey, S().tabs.m1.pinKey, "the same page pinned in both windows is one pin");
  assert.deepEqual(S().parkedPins, {}, "the park went into the open windows");
  assert.deepEqual(regular("w1"), ["https://r1.com"]);
});

// What liveTabs' intoWindow does when an extension moves a tab to another window (chrome.tabs.move).
const { removeTabs } = await import("./tabs.ts");
// `inGroup`: Chrome's group came along (chrome.tabGroups.move), which chromeChanged makes a store group.
function chromeMove(key, to, inGroup = false) {
  useBrowser.setState((s) => {
    const tab = s.tabs[key];
    const next = removeTabs(s, [key], false);
    const w = next.windows[to];
    const tabs = { ...next.tabs, [key]: { ...tab, windowId: to } };
    const groups = inGroup
      ? { ...next.groups, chrome: { id: "chrome", windowId: to, profileId: tab.profileId, name: "", icon: null, color: null, collapsed: false, pinned: false, tabIds: [key], createdAt: 0 } }
      : next.groups;
    return { ...next, tabs, groups, windows: { ...next.windows, [to]: { ...w, tabIds: model.pinnedFirst([...w.tabIds, key], tabs) } } };
  });
}
// A window's pins of one profile, whichever profile it shows.
const pinsOf = (w, profileId = "default") =>
  S().windows[w].tabIds.filter((id) => S().tabs[id].profileId === profileId && model.inPinnedContainer(S(), id)).map((id) => {
    const t = S().tabs[id];
    const g = Object.values(S().groups).find((g) => g.tabIds.includes(id));
    return `${g ? `${g.pinned ? "" : "regular "}${g.name}/` : ""}${t.url}${t.unloaded ? "" : "*"}`;
  });

test("an extension moving a pin to another window moves it: no pin lost, none doubled", () => {
  reset();
  const { w, mail, jira } = pinnedWindow();
  const n = S().createWindow();
  chromeMove(mail, n);
  assert.deepEqual(sidebar(n), ["https://mail.com*", "https://docs.com", "Work/https://jira.com"]);
  assert.deepEqual(sidebar(w), ["https://mail.com", "https://docs.com*", "Work/https://jira.com*"]);
  chromeMove(jira, n);
  assert.deepEqual(sidebar(n), ["https://mail.com*", "https://docs.com", "Work/https://jira.com*"], "a pinned group's tab too");
  assert.deepEqual(sidebar(w), ["https://mail.com", "https://docs.com*", "Work/https://jira.com"]);

  reset();
  const only = S().createWindow({ url: "mail.com" });
  const [m] = S().windows[only].tabIds;
  S().pinTabs([m], true);
  const other = S().createWindow();
  chromeMove(m, other);
  assert.equal(S().windows[only], undefined, "its window closed with it");
  assert.deepEqual(sidebar(other), ["https://mail.com*"], "one Mail");
});

test("an extension moving a pinned group's tab into a window of another profile keeps the pin", () => {
  reset();
  const { w, jira } = pinnedWindow();
  const other = S().createWindow({ profileId: S().createProfile({ name: "Work" }) });
  chromeMove(jira, other);
  assert.deepEqual(pinsOf(other), ["https://mail.com", "https://docs.com", "Work/https://jira.com*"], "that window now shows the profile's pins");
  assert.deepEqual(pinsOf(w), ["https://mail.com*", "https://docs.com*", "Work/https://jira.com"]);
});

test("a pin removed in the same update another pin moves into a window new to the profile stays removed", () => {
  reset();
  const { w, docs, jira } = pinnedWindow();
  const other = S().createWindow({ profileId: S().createProfile({ name: "Work" }) });
  useBrowser.setState((s) => {
    const tab = s.tabs[jira];
    const next = removeTabs(s, [jira, docs], false);
    const t = next.windows[other];
    const tabs = { ...next.tabs, [jira]: { ...tab, windowId: other } };
    return { ...next, tabs, windows: { ...next.windows, [other]: { ...t, tabIds: [...t.tabIds, jira] } } };
  });
  assert.deepEqual(pinsOf(other), ["https://mail.com", "Work/https://jira.com*"]);
  assert.deepEqual(pinsOf(w), ["https://mail.com*", "Work/https://jira.com"]);
});

test("an extension moving a pinned group's Chrome group: its tab is in the pinned group only", () => {
  reset();
  const { jira } = pinnedWindow();
  const n = S().createWindow();
  chromeMove(jira, n, true);
  assert.deepEqual(pinsOf(n), ["https://mail.com", "https://docs.com", "Work/https://jira.com*"]);
  assert.equal(S().groups.chrome, undefined);
  assert.equal(Object.values(S().groups).filter((g) => g.tabIds.includes(jira)).length, 1);
});

test("⇧⌘T of a pinned page whose pin's copy shows another page: it reopens as a tab, nothing is lost", () => {
  reset();
  const { w, mail } = pinnedWindow();
  const n = S().createWindow();
  S().navigated(mail, { url: "https://mail.com/one", title: "One" }, {});
  const copy = tabAt(n, "https://mail.com");
  S().activate(copy);
  S().navigated(copy, { url: "https://mail.com/two", title: "Two" }, {});
  S().closeTab(mail);
  S().closeWindow(w);
  S().reopenClosedTab(n);
  assert.equal(S().tabs[copy].url, "https://mail.com/two", "the copy keeps its page");
  assert.ok(regular(n).includes("https://mail.com/one"), "the closed page is back");
  assert.deepEqual(sidebar(n), ["https://mail.com/two*", "https://docs.com", "Work/https://jira.com"], "no second pin");
});

test("an old session's parked pin and the same page pinned in a window are one pin", () => {
  reset();
  const tab = (id, windowId, url, extra = {}) => ({
    id, windowId, profileId: "default", url, title: "", favicon: null, pinned: false, muted: false, zoom: 1, customTitle: null,
    customIcon: null, pinnedUrl: null, navigation: null, openerId: null, createdAt: 0, lastActiveAt: 0, ...extra,
  });
  const win = (id, tabIds) => ({ id, profileId: "default", incognito: false, tabIds, activeTabIds: { default: tabIds.at(-1) }, sidebarOpen: true, frame: null, createdAt: 0 });
  S().hydrate({
    profiles: { default: { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 } },
    windows: { w1: win("w1", ["r1"]), w2: win("w2", ["x2", "r2"]) },
    windowOrder: ["w1", "w2"],
    tabs: { r1: tab("r1", "w1", "https://r1.com"), x2: tab("x2", "w2", "https://x.com", { pinned: true }), r2: tab("r2", "w2", "https://r2.com") },
    parkedPins: { default: { tabs: [{ url: "https://x.com", title: "", favicon: null, pinned: true, muted: false, zoom: 1, customTitle: null, customIcon: null, pinnedUrl: "https://x.com", profileId: "default", id: "x", groupId: null }], groups: [] } },
  });
  assert.deepEqual(sidebar("w1").map((p) => p.replace("*", "")), ["https://x.com"]);
  assert.deepEqual(sidebar("w2").map((p) => p.replace("*", "")), ["https://x.com"]);
});
