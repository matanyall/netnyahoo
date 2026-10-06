import { addHistoryVisits, deleteHistoryUrls, deletePassword, savePassword } from "@netnyahoo/nncore";
import { assignPositions, SyncNative, type Adapter, type Extraction, type SavedLogin } from "@netnyahoo/sync";
import { bookmarkUuidFor, ensureRoots, isBookmarkUuid } from "../store/bookmarks";
import { MAX_HISTORY, MAX_VISIT_TIMES } from "../store/history";
import { useBrowser, type BrowserState } from "../store/browser";
import { orderSections, syncGroupOrder } from "../store/groups";
import { engineProfile, groupKeyOf, makeTab, newId, pinKeyOf, pinnedFirst, without } from "../store/model";
import { adoptParkedPins, parkWindowPins } from "../store/parkedPins";
import { pinHolder } from "../store/pinMirror";
import { removeTabs } from "../store/tabs";
import { DEFAULT_PROFILE_ID, type Settings } from "../store/settings";
import type { BookmarkNode, HistoryEntry, Profile, Tab, TabGroup } from "../store/types";

const store = () => useBrowser.getState();

// MARK: App scope: settings, profiles, devices

export const SYNCED_SETTINGS = [
  "warnBeforeQuitting",
  "warnBeforeClosingWindow",
  "searchEngine",
  "customSearchUrl",
  "customSearchEngines",
  "searchSuggestions",
  "commandBarPreference",
  "tabLayout",
  "hideToolbarWhileScrolling",
  "newTabPosition",
  "warnBeforeClosingLastTab",
  "warnBeforeMovingTabsToProfile",
  "tabReorderHaptics",
  "extendWebsiteColor",
  "cmdClickCreatesTabGroup",
  "optShiftClickOpensInGroup",
  "autoGroupMeetingTabs",
  "cleanUpInactiveTabsAfterHours",
  "mutedSites",
  "autoPictureInPicture",
  "showFullUrl",
  "bookmarksBar",
  "appearance",
  "addressBar",
  "shortcuts",
] as const satisfies readonly (keyof Settings)[];

export const settingsAdapter: Adapter = {
  prefix: "set:",
  adoptRemoteOnJoin: true,
  extract: () => {
    const settings = store().settings;
    return { values: new Map(SYNCED_SETTINGS.map((name) => [`set:${name}`, { v: settings[name] ?? null }])) };
  },
  apply: (visible, changed) => {
    const patch: Record<string, unknown> = {};
    for (const key of changed) {
      const name = key.slice(4);
      const record = visible.get(key) as { v: unknown } | undefined;
      if (record && "v" in record && (SYNCED_SETTINGS as readonly string[]).includes(name)) patch[name] = record.v;
    }
    if (Object.keys(patch).length) store().updateSettings(patch as Partial<Settings>);
  },
};

export type ProfileRecord = { n: string; c: Profile["color"]; i: string | null; d?: true };

export function profilesAdapter(links: () => Record<string, { syncId: string }>): Adapter {
  const linked = () => Object.entries(links()).filter(([id]) => store().profiles[id]);
  return {
    prefix: "prof:",
    adoptRemoteOnJoin: true,
    extract: () => {
      const values = new Map<string, unknown>();
      for (const [id, { syncId }] of linked()) {
        const p = store().profiles[id]!;
        values.set(`prof:${syncId}`, { n: p.name, c: p.color, i: p.icon, ...(id === DEFAULT_PROFILE_ID ? { d: true } : {}) } satisfies ProfileRecord);
      }
      const mine = new Set(values.keys());
      return { values, ignore: (key) => !mine.has(key) };
    },
    apply: (visible, changed) => {
      for (const [id, { syncId }] of linked()) {
        const record = visible.get(`prof:${syncId}`) as ProfileRecord | undefined;
        if (!record || !changed.has(`prof:${syncId}`)) continue;
        store().updateProfile(id, { name: record.n, color: record.c, icon: record.i });
      }
    },
  };
}

export type DeviceRecord = { n: string };

export function deviceAdapter(deviceId: string, name: () => string, retired = false): Adapter {
  return {
    prefix: "dev:",
    extract: () => ({
      values: retired ? new Map() : new Map([[`dev:${deviceId}`, { n: name() } satisfies DeviceRecord]]),
      ignore: (key) => key !== `dev:${deviceId}`,
    }),
    apply: () => true,
  };
}

// MARK: Profile scope

type BookmarkValue = { k: "u" | "f"; p: string; t: string; u?: string; a: number; pos: string };

// A bookmark's record key is its sync key: Chrome's UUID, or for a bookmark synced before Chrome kept bookmarks,
// its old id (kept on Chrome's node as `syncKey`), so Macs not yet updated and updated ones name it alike. A key
// that isn't a UUID becomes the node bookmarkUuidFor gives, on every Mac.
export function bookmarksAdapter(profileId: string): Adapter {
  // Before the tree is read from Chrome it's empty, which would read as every bookmark deleted.
  const ready = () => !!store().bookmarksReady[profileId];
  return {
    prefix: "bm:",
    extract: (base) => {
      if (!ready()) return null;
      const b = store().bookmarks;
      const roots = b.roots[profileId];
      const values = new Map<string, unknown>();
      if (!roots) return { values };
      // An old key names this node only if it maps to it (a copy of a bookmark carries its original's key along).
      const keyOf = (id: string) => {
        if (id === roots.bar) return "bar";
        if (id === roots.other) return "other";
        const key = b.nodes[id]?.syncKey;
        return key && bookmarkUuidFor(key) === id ? key : id;
      };
      const seen = new Set<string>();
      const walk = (folderId: string) => {
        const folder = b.nodes[folderId];
        if (folder?.kind !== "folder" || seen.has(folderId)) return;
        seen.add(folderId);
        const parent = keyOf(folderId);
        const children = folder.children.filter((id) => b.nodes[id]);
        const positions = assignPositions(
          children.map((id) => {
            const known = base(`bm:${keyOf(id)}`) as BookmarkValue | undefined;
            return known?.p === parent ? known.pos : undefined;
          }),
        );
        children.forEach((id, i) => {
          const node = b.nodes[id]!;
          values.set(`bm:${keyOf(id)}`, {
            k: node.kind === "url" ? "u" : "f",
            p: parent,
            t: node.title,
            ...(node.kind === "url" ? { u: node.url } : {}),
            a: node.addedAt,
            pos: positions[i]!,
          } satisfies BookmarkValue);
          if (node.kind === "folder") walk(id);
        });
      };
      walk(roots.bar);
      walk(roots.other);
      return { values };
    },
    apply: (visible) => {
      if (!ready()) return false;
      const s = store();
      const [b, roots] = ensureRoots(s.bookmarks, profileId);
      // By node id; a key that isn't a UUID names the node bookmarkUuidFor gives it.
      const values = new Map([...visible].map(([k, v]) => [bookmarkUuidFor(k.slice(3)), v as BookmarkValue]));
      const keys = new Map([...visible.keys()].map((k) => [bookmarkUuidFor(k.slice(3)), k.slice(3)]));
      const rootOf = (key: string) => (key === "bar" ? roots.bar : key === "other" ? roots.other : null);
      const parentOf = new Map<string, string>();
      for (const [id, v] of values) {
        const root = rootOf(v.p);
        const parent = root ? null : bookmarkUuidFor(v.p);
        parentOf.set(id, root ?? (parent && values.get(parent)?.k === "f" ? parent : roots.other));
      }
      for (const id of [...values.keys()].sort()) {
        const seen = new Set<string>([id]);
        for (let at = parentOf.get(id)!; parentOf.has(at); at = parentOf.get(at)!) {
          if (seen.has(at)) {
            parentOf.set(id, roots.other);
            break;
          }
          seen.add(at);
        }
      }
      const children = new Map<string, string[]>([[roots.bar, []], [roots.other, []]]);
      for (const id of values.keys()) children.set(parentOf.get(id)!, [...(children.get(parentOf.get(id)!) ?? []), id]);
      const byPosition = (a: string, z: string) => {
        const pa = values.get(a)!.pos;
        const pz = values.get(z)!.pos;
        const ka = keys.get(a)!;
        const kz = keys.get(z)!;
        return pa < pz ? -1 : pa > pz ? 1 : ka < kz ? -1 : 1;
      };
      const nodes: Record<string, BookmarkNode> = { ...b.nodes };
      const drop = (id: string) => {
        const node = nodes[id];
        if (node?.kind === "folder") node.children.forEach(drop);
        if (id !== roots.bar && id !== roots.other) delete nodes[id];
      };
      drop(roots.bar);
      drop(roots.other);
      for (const [id, v] of values) {
        const old = b.nodes[id];
        const key = keys.get(id)!;
        const syncKey = isBookmarkUuid(key) ? {} : { syncKey: key };
        nodes[id] =
          v.k === "u"
            ? { kind: "url", id, parentId: parentOf.get(id)!, title: v.t, url: v.u ?? "", favicon: old?.kind === "url" ? old.favicon : null, addedAt: v.a, ...syncKey }
            : { kind: "folder", id, parentId: parentOf.get(id)!, title: v.t, children: [], addedAt: v.a, ...syncKey };
      }
      for (const [parent, ids] of children) {
        const folder = nodes[parent];
        if (folder?.kind === "folder") nodes[parent] = { ...folder, children: ids.sort(byPosition) };
      }
      useBrowser.setState({ bookmarks: { ...b, nodes } });
    },
  };
}

export const HISTORY_WINDOW_MS = 90 * 86_400_000;

type HistoryValue = { t: string; n: number; vt: number[] };
const lastVisitOf = (v: HistoryValue) => Math.max(0, ...v.vt);
// What Chrome keeps in history (an app page, netnyahoo://, it doesn't): other records are left alone.
const keptInHistory = (url: string) => /^(https?|file):/i.test(url);
// Chrome stores visit times in microseconds and reports them in whole ms: the same visit reads back within this.
const SAME_VISIT_MS = 1;

export const historyExpired = (key: string, value: unknown, now: number) =>
  key.startsWith("h:") && lastVisitOf(value as HistoryValue) < now - HISTORY_WINDOW_MS;

// History is Chrome's (lib/history.ts keeps the store's view of it). Applying a record adds its visits to
// Chrome, so Chrome's copy then differs from the record (its own visit count and title). A local edit is a visit
// the record doesn't have; anything else publishes the record unchanged. Two Macs settle on the union of their
// visits instead of trading versions.
export function historyAdapter(profileId: string): Adapter {
  const ready = () => !!store().historyReady[profileId];
  return {
    prefix: "h:",
    extract: (base) => {
      // Before the view is read from Chrome it's empty, which would read as every URL deleted.
      if (!ready()) return null;
      const since = Date.now() - HISTORY_WINDOW_MS;
      const values = new Map<string, unknown>();
      const older = new Set<string>();
      const view = store().history[profileId] ?? [];
      // The view holds Chrome's newest MAX_HISTORY URLs: one visited at or before this may only be missing from it.
      const floor = store().historyFloor[profileId] ?? -Infinity;
      for (const e of view) {
        if (!keptInHistory(e.url)) continue;
        const key = `h:${e.url}`;
        if (e.lastVisit < since) {
          older.add(key);
          continue;
        }
        const local: HistoryValue = { t: e.title, n: e.visits, vt: e.visitTimes?.length ? e.visitTimes : [e.lastVisit] };
        const known = base(key) as HistoryValue | undefined;
        const edited = !known || local.vt.some((t) => !known.vt.some((k) => Math.abs(k - t) <= SAME_VISIT_MS));
        values.set(key, edited ? local : known);
      }
      const ignore = (key: string) => {
        if (older.has(key) || !keptInHistory(key.slice(2))) return true;
        // Chrome expired it (as every Mac does), or the view no longer reaches it: not a deletion.
        const known = base(key) as HistoryValue | undefined;
        return !!known && (lastVisitOf(known) < since || lastVisitOf(known) <= floor);
      };
      return { values, ignore };
    },
    editedAt: (v) => lastVisitOf(v as HistoryValue),
    apply: async (visible, changed) => {
      if (!ready()) return false;
      const since = Date.now() - HISTORY_WINDOW_MS;
      const byUrl = new Map((store().history[profileId] ?? []).map((e) => [e.url, e]));
      const add: { url: string; title: string; visitTimes: number[] }[] = [];
      const remove: string[] = [];
      const updates = new Map<string, HistoryEntry | null>();
      for (const key of changed) {
        const url = key.slice(2);
        if (!keptInHistory(url)) continue;
        const v = visible.get(key) as HistoryValue | undefined;
        const old = byUrl.get(url);
        if (v) {
          const have = old?.visitTimes ?? [];
          const fresh = v.vt.filter((t) => t >= since && !have.some((h) => Math.abs(h - t) <= SAME_VISIT_MS));
          if (fresh.length) add.push({ url, title: v.t, visitTimes: fresh });
          const times = [...have, ...fresh].sort((a, z) => a - z).slice(-MAX_VISIT_TIMES);
          if (!times.length) continue;
          updates.set(url, {
            url,
            title: v.t || old?.title || "",
            favicon: null,
            visits: Math.max(v.n, old?.visits ?? 0),
            lastVisit: times[times.length - 1]!,
            visitTimes: times,
          });
        } else if (old && old.lastVisit >= since) {
          remove.push(url);
          updates.set(url, null);
        }
      }
      if (!updates.size) return;
      const engine = engineProfile(profileId);
      await Promise.all([addHistoryVisits(engine, add, SAME_VISIT_MS), deleteHistoryUrls(engine, remove)]);
      // The view as it is now (Chrome's reports may have landed meanwhile), with the records merged in.
      useBrowser.setState((s) => {
        const current = new Map((s.history[profileId] ?? []).map((e) => [e.url, e]));
        for (const [url, update] of updates) {
          const now = current.get(url);
          if (!update) current.delete(url);
          else if (!now) current.set(url, update);
          else {
            const times = [...new Set([...(now.visitTimes ?? []), ...(update.visitTimes ?? [])])].sort((a, z) => a - z).slice(-MAX_VISIT_TIMES);
            current.set(url, { ...update, visits: Math.max(now.visits, update.visits), lastVisit: times[times.length - 1]!, visitTimes: times });
          }
        }
        const list = [...current.values()].sort((a, z) => z.lastVisit - a.lastVisit).slice(0, MAX_HISTORY);
        return { history: { ...s.history, [profileId]: list } };
      });
    },
  };
}

export type DeviceTabs = { n: string; tabs: { u: string; t: string }[] };
const MAX_DEVICE_TABS = 30;

export function deviceTabsAdapter(profileId: string, deviceId: string, name: () => string, retired = false): Adapter {
  const key = `tabs:${deviceId}`;
  return {
    prefix: "tabs:",
    extract: () => {
      if (retired) return { values: new Map(), ignore: (k) => k !== key };
      const s = store();
      const open = Object.values(s.tabs)
        // Pinned tabs sync as pinned tabs; unloaded tiles aren't open.
        .filter((t) => t.profileId === profileId && !t.pinned && !t.unloaded && /^(https?|file):/.test(t.url) && !s.windows[t.windowId]?.incognito)
        .sort((a, z) => z.lastActiveAt - a.lastActiveAt)
        .slice(0, MAX_DEVICE_TABS)
        .map((t) => ({ u: t.url, t: t.customTitle || t.title }));
      return { values: new Map([[key, { n: name(), tabs: open } satisfies DeviceTabs]]), ignore: (k) => k !== key };
    },
    apply: () => true,
  };
}

type PinValue = { g: string | null; u: string; t: string | null; i: string | null; ti: string; pos: string };
type PinGroupValue = { n: string; i: string | null; c: TabGroup["color"]; pos: string };

type Window = BrowserState["windows"][string];

// Small Yahu's page isn't one of the open tabs: it's thrown away when the window closes.
const openWindows = (s: BrowserState) => s.windowOrder.map((id) => s.windows[id]).filter((w): w is Window => !!w && !w.incognito && w.kind !== "small");

// Every window showing the profile holds a copy of each pin (store/pinMirror.ts): one record per pin, keyed by the key
// its copies share (`tab.pinKey`, `group.pinKey`; a pin from before keys is keyed by its tab or group id, as before).
export function pinnedAdapter(profileId: string): Adapter {
  return {
    prefix: "pin:",
    extract: (base) => {
      const s = store();
      type Pin = Pick<Tab, "url" | "title" | "customTitle" | "customIcon"> & { key: string; pinnedUrl?: string | null };
      const tiles: Pin[] = [];
      const groups: (Pick<TabGroup, "name" | "icon" | "color"> & { key: string })[] = [];
      const members = new Map<string, Pin[]>();
      const groupOf = (key: string, g: Pick<TabGroup, "name" | "icon" | "color">) => {
        if (!members.has(key)) {
          members.set(key, []);
          groups.push({ key, name: g.name, icon: g.icon, color: g.color });
        }
        return members.get(key)!;
      };
      // Each pin's copies, in the order `apply` writes into windows (pinHolder's), then the park.
      type Copy = Pin & { unloaded: boolean; group: string | null };
      const copies = new Map<string, Copy[]>();
      const add = (key: string, pin: Pin, unloaded: boolean, group: string | null) => {
        if (!copies.has(key)) copies.set(key, []);
        copies.get(key)!.push({ ...pin, key, unloaded, group });
      };
      const pinnedGroupOf = new Map<string, TabGroup>();
      for (const g of Object.values(s.groups)) if (g.pinned && g.profileId === profileId) g.tabIds.forEach((id) => pinnedGroupOf.set(id, g));
      const order = [...new Set([...s.ui.focusOrder, ...s.windowOrder])].filter((id) => openWindows(s).includes(s.windows[id]!));
      for (const w of order.map((id) => s.windows[id]!)) {
        for (const id of w.tabIds) {
          const t = s.tabs[id];
          if (!t || t.profileId !== profileId) continue;
          const g = t.pinned ? undefined : pinnedGroupOf.get(id);
          if (!t.pinned && !g) continue;
          if (g) groupOf(groupKeyOf(g), g);
          add(pinKeyOf(t), { ...t, key: pinKeyOf(t) }, !!t.unloaded, g ? groupKeyOf(g) : null);
        }
      }
      const park = s.parkedPins[profileId];
      const parkedGroupKey = new Map((park?.groups ?? []).map((g) => [g.id, groupKeyOf(g)]));
      for (const g of park?.groups ?? []) groupOf(groupKeyOf(g), g);
      for (const p of park?.tabs ?? []) {
        const group = p.groupId ? parkedGroupKey.get(p.groupId) : null;
        if (group !== undefined) add(p.pinKey ?? p.id, { ...p, key: p.pinKey ?? p.id }, true, group);
      }
      // What a pin syncs is the page its copies open at. A copy showing a page shows its window's own (navigating a
      // pin isn't mirrored), so an unloaded copy speaks for the pin, the one still at the synced page first; with
      // every copy showing a page, the synced page stays (two Macs on different pages would otherwise trade them).
      for (const [key, list] of copies) {
        const synced = base(`pin:t:${key}`) as PinValue | undefined;
        const first = list[0]!;
        const waiting = list.filter((c) => c.unloaded);
        const pick =
          waiting.find((c) => !!synced && c.url === synced.u) ??
          waiting[0] ??
          (synced && synced.g === first.group ? { ...first, url: synced.u, title: synced.ti } : first);
        (first.group ? members.get(first.group) : tiles)?.push(pick);
      }
      const values = new Map<string, unknown>();
      const place = (tabs: Pin[], group: string | null) => {
        const positions = assignPositions(tabs.map((t) => ((base(`pin:t:${t.key}`) as PinValue | undefined)?.g ?? null) === group ? (base(`pin:t:${t.key}`) as PinValue | undefined)?.pos : undefined));
        tabs.forEach((t, i) =>
          values.set(`pin:t:${t.key}`, { g: group, u: (group ? t.url : t.pinnedUrl || t.url) || "", t: t.customTitle, i: t.customIcon, ti: t.title, pos: positions[i]! } satisfies PinValue),
        );
      };
      place(tiles, null);
      const groupPositions = assignPositions(groups.map((g) => (base(`pin:g:${g.key}`) as PinGroupValue | undefined)?.pos));
      groups.forEach((g, i) => {
        values.set(`pin:g:${g.key}`, { n: g.name, i: g.icon, c: g.color, pos: groupPositions[i]! } satisfies PinGroupValue);
        place(members.get(g.key)!, g.key);
      });
      return { values } satisfies Extraction;
    },
    // Remote changes land in one window showing the profile, and the store mirrors them to its other windows; with
    // none, in the park.
    apply: (visible, changed) => {
      let s = store();
      if (!openWindows(s).length) return false;
      const PARK = `park:${profileId}`;
      let homeId = pinHolder(s, profileId);
      if (!homeId) {
        homeId = PARK;
        const stand: Window = { id: PARK, profileId, incognito: false, tabIds: [], activeTabIds: {}, sidebarOpen: true, frame: null, createdAt: 0 };
        s = { ...s, windows: { ...s.windows, [PARK]: stand } };
        if (s.parkedPins[profileId]) s = adoptParkedPins(s, PARK, profileId);
      }
      const tabByKey = new Map<string, string>();
      for (const id of s.windows[homeId]!.tabIds) {
        const t = s.tabs[id];
        if (t?.profileId === profileId && t.pinKey && !tabByKey.has(t.pinKey)) tabByKey.set(t.pinKey, id);
      }
      const groupByKey = new Map<string, string>();
      for (const g of Object.values(s.groups)) if (g.windowId === homeId && g.profileId === profileId && g.pinned && !groupByKey.has(groupKeyOf(g))) groupByKey.set(groupKeyOf(g), g.id);

      const pins = new Map<string, PinValue>();
      const groupValues = new Map<string, PinGroupValue>();
      for (const [k, v] of visible) {
        if (k.startsWith("pin:t:")) pins.set(k.slice(6), v as PinValue);
        else if (k.startsWith("pin:g:")) groupValues.set(k.slice(6), v as PinGroupValue);
      }
      const byPos = <T extends { pos: string }>(m: Map<string, T>) => (a: string, z: string) =>
        m.get(a)!.pos < m.get(z)!.pos ? -1 : m.get(a)!.pos > m.get(z)!.pos ? 1 : a < z ? -1 : 1;
      const groupOrder = [...groupValues.keys()].sort(byPos(groupValues));
      const tileOrder = [...pins.keys()].filter((key) => { const g = pins.get(key)!.g; return !g || !groupValues.has(g); }).sort(byPos(pins));

      const goneTabs = [...changed].filter((k) => k.startsWith("pin:t:") && !visible.has(k)).map((k) => tabByKey.get(k.slice(6))).filter((id): id is string => !!id && !!s.tabs[id]);
      // Unpinned elsewhere: a tile showing nothing goes; one showing a page stays, as a regular tab.
      const removable = goneTabs.filter((id) => {
        const w = s.windows[s.tabs[id]!.windowId];
        return s.tabs[id]!.unloaded && w && w.tabIds.some((other) => other !== id && !goneTabs.includes(other));
      });
      s = removeTabs(s, removable, false);
      const tabs = { ...s.tabs };
      for (const id of goneTabs) {
        if (!tabs[id]) continue;
        const { pinKey: _, ...t } = tabs[id]!;
        tabs[id] = { ...t, pinned: false, pinnedUrl: null };
      }
      let groups = { ...s.groups };
      for (const k of changed) if (k.startsWith("pin:g:") && !visible.has(k) && groupByKey.has(k.slice(6))) delete groups[groupByKey.get(k.slice(6))!];
      const windows = { ...s.windows };

      const groupIdOf = new Map<string, string>();
      for (const key of groupOrder) {
        const v = groupValues.get(key)!;
        const old = groups[groupByKey.get(key) ?? ""];
        const id = old?.id ?? (groups[key] ? newId("g") : key);
        groups[id] = old
          ? { ...old, name: v.n, icon: v.i, color: v.c, pinned: true }
          : { id, windowId: homeId, profileId, name: v.n, icon: v.i, color: v.c, collapsed: false, pinned: true, pinKey: key, tabIds: [], createdAt: Date.now() };
        groupIdOf.set(key, id);
      }
      const tabIdOf = new Map<string, string>();
      for (const [key, v] of pins) {
        const group = v.g && groupIdOf.has(v.g) ? groups[groupIdOf.get(v.g)!]! : null;
        const old = tabs[tabByKey.get(key) ?? ""];
        if (old) {
          tabs[old.id] = {
            ...old,
            pinned: !group,
            pinnedUrl: group ? null : v.u,
            customTitle: v.t,
            customIcon: v.i,
            ...(old.unloaded ? { url: v.u, title: v.ti } : {}),
          };
          tabIdOf.set(key, old.id);
          continue;
        }
        const w = windows[homeId]!;
        const tab: Tab = {
          ...makeTab(homeId, profileId, v.u, { title: v.ti, pinned: !group, customTitle: v.t, customIcon: v.i }),
          id: tabs[key] ? newId("tab") : key,
          pinKey: key,
          pinnedUrl: group ? null : v.u,
          navigation: null,
          unloaded: true,
        };
        tabs[tab.id] = tab;
        windows[homeId] = { ...w, tabIds: [...w.tabIds, tab.id] };
        tabIdOf.set(key, tab.id);
      }
      const ids = (keys: string[]) => keys.map((k) => tabIdOf.get(k)).filter((id): id is string => !!id && !!tabs[id]);
      const memberOrder = new Map(groupOrder.map((g) => [g, ids([...pins.keys()].filter((key) => pins.get(key)!.g === g).sort(byPos(pins)))]));
      const inGroup = new Set([...memberOrder.values()].flat());
      for (const g of Object.values(groups)) {
        if (g.profileId !== profileId || g.windowId !== homeId) continue;
        const key = groupKeyOf(g);
        const wanted = g.pinned && memberOrder.has(key) && groupIdOf.get(key) === g.id ? memberOrder.get(key)! : g.tabIds.filter((id) => !inGroup.has(id));
        groups[g.id] = { ...g, tabIds: wanted };
      }
      for (const g of Object.values(groups)) if (g.profileId === profileId && g.windowId === homeId && !g.tabIds.length) delete groups[g.id];

      const sequence = [...ids(tileOrder), ...groupOrder.flatMap((g) => memberOrder.get(g) ?? [])];
      const rank = new Map(sequence.map((id, i) => [id, i]));
      const w = windows[homeId]!;
      const order = w.tabIds.filter((id) => tabs[id]);
      const slots = order.map((id, i) => (rank.has(id) ? i : -1)).filter((i) => i >= 0);
      const sorted = slots.map((i) => order[i]!).sort((a, z) => rank.get(a)! - rank.get(z)!);
      slots.forEach((slot, i) => (order[slot] = sorted[i]!));
      const window = { ...w, tabIds: orderSections(pinnedFirst(order, tabs), tabs, groups) };
      windows[homeId] = window;
      groups = syncGroupOrder(groups, window);
      let { live, parkedPins } = s;
      const parkWindow = windows[PARK];
      if (parkWindow) {
        parkedPins = parkWindowPins(parkedPins, parkWindow, { tabs, groups, history: s.history });
        for (const id of parkWindow.tabIds) delete tabs[id];
        live = without(live, parkWindow.tabIds);
        groups = Object.fromEntries(Object.entries(groups).filter(([, g]) => g.windowId !== PARK));
        delete windows[PARK];
      }
      const { find, splits, selection, windowOrder, windowUi } = s;
      useBrowser.setState({ tabs, windows, groups, live, find, splits, selection, windowOrder, windowUi, parkedPins });
    },
  };
}

// MARK: Passwords

type PasswordValue = { o: string; u: string; p: string };
const PASSWORD_READ_INTERVAL = 30_000;

// Sync passwords through Chrome; disabling sync never deletes local passwords.
export function passwordsAdapter(
  profileId: string,
  forced: () => boolean,
  readLogins: (engineProfile: string) => Promise<SavedLogin[] | null | undefined> = async (p) => SyncNative?.readPasswords(p),
): Adapter {
  let lastRead = 0;
  let quietUntil = 0;
  let created = new Map<string, number>();
  const profile = () => engineProfile(profileId);
  const keyOf = (origin: string, username: string) => `pw:${origin}\n${username}`;
  const read = async () => {
    const logins = await readLogins(profile());
    if (!logins) return null;
    const out = new Map<string, PasswordValue & { c: number }>();
    for (const l of logins) {
      const origin = originOf(l);
      if (origin) out.set(keyOf(origin, l.username), { o: origin, u: l.username, p: l.password, c: l.created });
    }
    return out;
  };
  return {
    prefix: "pw:",
    extract: async () => {
      const now = Date.now();
      if (now < quietUntil || (now - lastRead < PASSWORD_READ_INTERVAL && !forced())) return null;
      const logins = await read();
      if (!logins) return null;
      lastRead = now;
      created = new Map([...logins].map(([k, v]) => [k, v.c]));
      return { values: new Map([...logins].map(([k, { o, u, p }]) => [k, { o, u, p } satisfies PasswordValue])) };
    },
    editedAt: (v) => created.get(keyOf((v as PasswordValue).o, (v as PasswordValue).u)) || undefined,
    apply: async (visible, changed, base) => {
      const local = await read();
      if (!local) return false;
      let ok = true;
      for (const key of changed) {
        const v = visible.get(key) as PasswordValue | undefined;
        const have = local.get(key);
        const known = base(key) as PasswordValue | undefined;
        if (have && known?.p !== have.p) continue;
        const [origin, username] = [key.slice(3, key.indexOf("\n")), key.slice(key.indexOf("\n") + 1)];
        if (v) {
          if (have?.p === v.p) continue;
          if (have) ok = (await deletePassword(profile(), origin, username)) && ok;
          ok = (await savePassword(profile(), v.o, v.u, v.p)) && ok;
        } else if (have) {
          ok = (await deletePassword(profile(), origin, username)) && ok;
        }
      }
      // Wait for Chrome to write password changes before reading them.
      let settled = false;
      for (let i = 0; i < 20 && !settled; i++) {
        const now = await read();
        settled = !!now && [...changed].every((k) => (visible.get(k) as PasswordValue | undefined)?.p === now.get(k)?.p);
        if (!settled) await new Promise((r) => setTimeout(r, 250));
      }
      if (!settled) quietUntil = Date.now() + 30_000;
      return ok;
    },
  };
}

function originOf(login: SavedLogin): string | null {
  const realm = login.origin.replace(/\/$/, "");
  return /^https?:\/\/[^/\s]+$/.test(realm) ? realm : null;
}
