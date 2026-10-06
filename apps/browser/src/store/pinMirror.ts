// Pinned tabs are the profile's, as in Arc (this fork's choice; Dia keeps them per window): every window that shows a
// profile holds the same pinned tiles and pinned groups, each window with its own Tab (its own page, loaded when
// first shown). The copies of one pin share `tab.pinKey`, a pinned group's copies `group.pinKey`.
//
// The store runs `mirrorPins` on every update (store/browser.ts): an edit to one window's pins (pin, unpin, order,
// custom title or icon, pinned URL, pinned groups and their members) reaches the profile's other windows, and a window
// that starts showing a profile (a new window, a profile switch) gets unloaded copies. What a pin shows is each
// window's own: navigating, unloading (⌘W) and waking aren't mirrored. A copy that's gone elsewhere (unpinned, its
// group deleted) leaves a window only if it isn't showing a page there; one that is stays as a regular tab.
// Private windows and Small Yahu have no shared pins.
import type { BrowserState } from "./browser";
import { leaveGroups, orderSections, placeBlock, syncGroupOrder } from "./groups";
import { groupKeyOf, IDLE_LIVE, inPinnedContainer, makeTab, merge, newId, pinKeyOf, pinnedFirst } from "./model";
import { samePage } from "./organize";
import { adoptParkedPins } from "./parkedPins";
import { removeTabs } from "./tabs";
import type { BrowserWindow, Tab, TabGroup } from "./types";

type Tile = { key: string; tab: string; pinnedUrl: string | null; customTitle: string | null; customIcon: string | null };
type Member = { key: string; tab: string; customTitle: string | null; customIcon: string | null; blank: boolean };
type Group = { key: string; group: string; name: string; icon: string | null; color: TabGroup["color"]; members: Member[] };
// One window's pins of one profile, in sidebar order. `tab` / `group` are that window's ids (where copies come from).
type PinSet = { windowId: string; profileId: string; tiles: Tile[]; groups: Group[]; sig: string };

type Source = Pick<BrowserState, "tabs" | "groups" | "windows" | "windowOrder">;

export const mirrorsPins = (w: BrowserWindow | undefined): w is BrowserWindow => !!w && !w.incognito && w.kind !== "small";

// A copy with a page the user may be on (not an unloaded tile) is never thrown away.
const hasPage = (t: Tab) => !t.unloaded;

// The profiles a window shows: its own and every profile it holds a tab of (a window pages between profiles).
function profilesIn(s: Pick<BrowserState, "tabs">, w: BrowserWindow): Set<string> {
  const out = new Set([w.profileId]);
  for (const id of w.tabIds) {
    const p = s.tabs[id]?.profileId;
    if (p) out.add(p);
  }
  return out;
}

/** The profiles other windows than `windowId` show: closing that window parks none of these pins. */
export function profilesShownElsewhere(s: Source, windowId: string): Set<string> {
  const out = new Set<string>();
  for (const w of Object.values(s.windows)) if (w.id !== windowId && mirrorsPins(w)) for (const p of profilesIn(s, w)) out.add(p);
  return out;
}

/** A window showing the profile, the focused one first (sync applies remote pins there; the others mirror it). */
export function pinHolder(s: BrowserState, profileId: string): string | undefined {
  return [...s.ui.focusOrder, ...s.windowOrder].find((id) => mirrorsPins(s.windows[id]) && profilesIn(s, s.windows[id]!).has(profileId));
}

function pinnedGroupsByTab(s: Pick<BrowserState, "groups">, windowId: string): Map<string, TabGroup> {
  const out = new Map<string, TabGroup>();
  for (const g of Object.values(s.groups)) if (g.pinned && g.windowId === windowId) for (const id of g.tabIds) out.set(id, g);
  return out;
}

type Pin = { id: string; key: string; group: TabGroup | null };

// The window's pins of a profile, one per key: of two copies in one window (an extension moved one in) the one
// with a page stays, else the first.
function pinsIn(s: Pick<BrowserState, "tabs">, w: BrowserWindow, profileId: string, groupOf: Map<string, TabGroup>) {
  const pins: Pin[] = [];
  const at = new Map<string, number>();
  const dups: string[] = [];
  for (const id of w.tabIds) {
    const t = s.tabs[id];
    if (!t || t.profileId !== profileId) continue;
    const group = t.pinned ? null : (groupOf.get(id) ?? null);
    if (!t.pinned && !group) continue;
    const key = pinKeyOf(t);
    const i = at.get(key);
    if (i === undefined) {
      at.set(key, pins.length);
      pins.push({ id, key, group });
    } else if (!hasPage(s.tabs[pins[i]!.id]!) && hasPage(t)) {
      dups.push(pins[i]!.id);
      pins[i] = { id, key, group };
    } else dups.push(id);
  }
  return { pins, dups };
}

function withSig(set: Omit<PinSet, "sig">): PinSet {
  const sig = JSON.stringify([
    set.tiles.map((t) => [t.key, t.pinnedUrl, t.customTitle, t.customIcon]),
    set.groups.map((g) => [g.key, g.name, g.icon, g.color, g.members.map((m) => [m.key, m.customTitle, m.customIcon, m.blank])]),
  ]);
  return { ...set, sig };
}

function pinSetIn(s: Source, w: BrowserWindow, profileId: string, groupOf: Map<string, TabGroup>): PinSet {
  const tiles: Tile[] = [];
  const groups: Group[] = [];
  const byKey = new Map<string, Group>();
  for (const p of pinsIn(s, w, profileId, groupOf).pins) {
    const t = s.tabs[p.id]!;
    if (!p.group) {
      tiles.push({ key: p.key, tab: p.id, pinnedUrl: t.pinnedUrl, customTitle: t.customTitle, customIcon: t.customIcon });
      continue;
    }
    const gk = groupKeyOf(p.group);
    let g = byKey.get(gk);
    if (!g) {
      g = { key: gk, group: p.group.id, name: p.group.name, icon: p.group.icon, color: p.group.color, members: [] };
      byKey.set(gk, g);
      groups.push(g);
    }
    g.members.push({ key: p.key, tab: p.id, customTitle: t.customTitle, customIcon: t.customIcon, blank: !t.url });
  }
  return withSig({ windowId: w.id, profileId, tiles, groups });
}

// The previous update's sets are the next one's "before": keep the last two.
const cached: { refs: unknown[]; sets: Map<string, PinSet[]> }[] = [];

function pinSets(s: Source): Map<string, PinSet[]> {
  const refs = [s.tabs, s.groups, s.windows, s.windowOrder];
  const hit = cached.find((c) => c.refs.every((r, i) => r === refs[i]));
  if (hit) return hit.sets;
  const sets = new Map<string, PinSet[]>();
  const listed = new Set(s.windowOrder);
  for (const id of [...s.windowOrder, ...Object.keys(s.windows).filter((w) => !listed.has(w))]) {
    const w = s.windows[id];
    if (!mirrorsPins(w)) continue;
    const groupOf = pinnedGroupsByTab(s, id);
    for (const profileId of profilesIn(s, w)) {
      const list = sets.get(profileId) ?? [];
      list.push(pinSetIn(s, w, profileId, groupOf));
      sets.set(profileId, list);
    }
  }
  cached.unshift({ refs, sets });
  cached.length = Math.min(cached.length, 2);
  return sets;
}

/** Every pinned tile, pinned group member and pinned group of a shared window has a key; nothing else keeps one. */
export function normalizeKeys(s: BrowserState): BrowserState {
  const members = new Set<string>();
  for (const g of Object.values(s.groups)) if (g.pinned) for (const id of g.tabIds) members.add(id);
  let tabs = s.tabs;
  for (const t of Object.values(s.tabs)) {
    if (!mirrorsPins(s.windows[t.windowId])) continue;
    const pinned = t.pinned || members.has(t.id);
    if (pinned === (t.pinKey !== undefined)) continue;
    if (tabs === s.tabs) tabs = { ...s.tabs };
    if (pinned) tabs[t.id] = { ...t, pinKey: t.id };
    else {
      const { pinKey: _, ...rest } = t;
      tabs[t.id] = rest;
    }
  }
  let groups = s.groups;
  for (const g of Object.values(s.groups)) {
    if (!mirrorsPins(s.windows[g.windowId]) || g.pinned === (g.pinKey !== undefined)) continue;
    if (groups === s.groups) groups = { ...s.groups };
    if (g.pinned) groups[g.id] = { ...g, pinKey: g.id };
    else {
      const { pinKey: _, ...rest } = g;
      groups[g.id] = rest;
    }
  }
  return tabs === s.tabs && groups === s.groups ? s : { ...s, tabs, groups };
}

function union(a: PinSet, b: PinSet): PinSet {
  const keys = new Set([...a.tiles.map((t) => t.key), ...a.groups.flatMap((g) => g.members.map((m) => m.key))]);
  const tiles = [...a.tiles, ...b.tiles.filter((t) => !keys.has(t.key))];
  const groups = a.groups.map((g) => ({ ...g, members: [...g.members] }));
  for (const g of b.groups) {
    const members = g.members.filter((m) => !keys.has(m.key));
    const into = groups.find((x) => x.key === g.key);
    if (into) into.members.push(...members);
    else if (members.length) groups.push({ ...g, members });
  }
  return withSig({ windowId: a.windowId, profileId: a.profileId, tiles, groups });
}

// An unloaded copy of a tile shows its pinned page: the title Chrome's history has for it when the source is away.
function atHome(s: BrowserState, src: Tab, home: string): Pick<Tab, "title" | "favicon"> {
  if (!src.url || samePage(src.url, home)) return { title: src.title, favicon: src.favicon };
  const entry = s.history[src.profileId]?.find((h) => samePage(h.url, home));
  return { title: entry?.title ?? "", favicon: entry?.favicon ?? src.favicon };
}

/** Makes a window's pins of a profile `canon`'s: copies the ones it lacks (unloaded), updates the rest, puts them in
 * canon's order; a pin it has that canon hasn't goes, or stays as a regular tab if it shows a page. `base` holds the
 * tabs canon names. */
function applyPins(s: BrowserState, base: BrowserState, windowId: string, profileId: string, canon: PinSet): BrowserState {
  const w = s.windows[windowId]!;
  const windowGroups = Object.values(s.groups).filter((g) => g.windowId === windowId && g.profileId === profileId);
  const groupOf = new Map<string, TabGroup>();
  for (const g of windowGroups) if (g.pinned) for (const id of g.tabIds) groupOf.set(id, g);
  const { pins, dups } = pinsIn(s, w, profileId, groupOf);
  const have = new Map(pins.map((p) => [p.key, p.id]));
  const tabs = { ...s.tabs };
  const live = { ...s.live };
  let groups = { ...s.groups };
  const added: string[] = [];
  const copy = (patch: Partial<Tab>) => {
    const t: Tab = { ...makeTab(windowId, profileId), ...patch, navigation: null, unloaded: true };
    tabs[t.id] = t;
    live[t.id] = IDLE_LIVE;
    added.push(t.id);
    return t.id;
  };

  const tileIds: string[] = [];
  for (const e of canon.tiles) {
    const src = base.tabs[e.tab];
    const id = have.get(e.key);
    if (!id) {
      if (!src) continue;
      const home = e.pinnedUrl || src.url;
      tileIds.push(copy({ url: home, ...atHome(base, src, home), pinned: true, pinnedUrl: e.pinnedUrl, customTitle: e.customTitle, customIcon: e.customIcon, pinKey: e.key }));
      continue;
    }
    const t = tabs[id]!;
    // A copy that isn't showing anything follows a new pinned URL; one showing a page keeps it.
    const moved = t.unloaded && e.pinnedUrl && !samePage(t.url, e.pinnedUrl) ? { url: e.pinnedUrl, ...atHome(base, src ?? t, e.pinnedUrl) } : {};
    tabs[id] = merge(t, { pinned: true, pinnedUrl: e.pinnedUrl, customTitle: e.customTitle, customIcon: e.customIcon, pinKey: e.key, ...moved });
    tileIds.push(id);
  }

  const wantedGroups: TabGroup[] = [];
  for (const ge of canon.groups) {
    const ids: string[] = [];
    for (const m of ge.members) {
      const src = base.tabs[m.tab];
      const id = have.get(m.key);
      if (!id) {
        if (src) ids.push(copy({ url: src.url, title: src.title, favicon: src.favicon, customTitle: m.customTitle, customIcon: m.customIcon, pinKey: m.key }));
        continue;
      }
      const t = tabs[id]!;
      // A New Tab page added to the group, then given a page: the copies still waiting for one take it.
      const filled = t.unloaded && !t.url && src?.url ? { url: src.url, title: src.title, favicon: src.favicon } : {};
      tabs[id] = merge(t, { pinned: false, pinnedUrl: null, customTitle: m.customTitle, customIcon: m.customIcon, pinKey: m.key, ...filled });
      ids.push(id);
    }
    if (!ids.length) continue;
    const existing = windowGroups.find((g) => g.pinned && groupKeyOf(g) === ge.key && !wantedGroups.some((x) => x.id === g.id));
    const id = existing?.id ?? newId("g");
    const fresh = { id, windowId, profileId, collapsed: base.groups[ge.group]?.collapsed ?? false, createdAt: Date.now() };
    const group: TabGroup = { ...(existing ?? fresh), name: ge.name, icon: ge.icon, color: ge.color, pinned: true, pinKey: ge.key, tabIds: ids };
    groups[id] = group;
    wantedGroups.push(group);
  }

  const assigned = new Set([...tileIds, ...wantedGroups.flatMap((g) => g.tabIds)]);
  const remove = new Set<string>();
  for (const id of [...pins.map((p) => p.id), ...dups]) {
    if (assigned.has(id)) continue;
    const t = tabs[id]!;
    if (!hasPage(t)) {
      remove.add(id);
      continue;
    }
    const { pinKey: _, ...rest } = t;
    tabs[id] = { ...rest, pinned: false, pinnedUrl: null };
  }
  // The window's other groups give up the tabs placed above; its pinned groups canon hasn't become regular groups of
  // the pages they still show.
  for (const g of Object.values(groups)) {
    if (g.windowId !== windowId || wantedGroups.some((x) => x.id === g.id)) continue;
    const dropped = g.pinned && g.profileId === profileId;
    const kept = g.tabIds.filter((id) => !assigned.has(id) && !remove.has(id));
    if (kept.length === g.tabIds.length && !dropped) continue;
    if (!kept.length) {
      delete groups[g.id];
      continue;
    }
    const { pinKey: _, ...rest } = g;
    groups[g.id] = dropped ? { ...rest, pinned: false, tabIds: kept } : { ...g, tabIds: kept };
  }

  const rank = new Map([...tileIds, ...wantedGroups.flatMap((g) => g.tabIds)].map((id, i) => [id, i]));
  let ids = [...w.tabIds, ...added];
  const slots = ids.flatMap((id, i) => (rank.has(id) ? [i] : []));
  const sorted = slots.map((i) => ids[i]!).sort((a, z) => rank.get(a)! - rank.get(z)!);
  slots.forEach((slot, i) => (ids[slot] = sorted[i]!));
  ids = orderSections(pinnedFirst(ids, tabs), tabs, groups);
  for (const g of wantedGroups) ids = placeBlock(ids, ids.filter((id) => g.tabIds.includes(id)));
  const window = { ...w, tabIds: ids };
  const next: BrowserState = { ...s, tabs, live, groups: syncGroupOrder(groups, window), windows: { ...s.windows, [windowId]: window } };
  return remove.size ? removeTabs(next, [...remove], false) : next;
}

// A pin moved into `windowId` (keys by tab id) whose copy is there already: one of the two keeps the place (the one
// showing a page; both showing one: the moved tab, unless merging), the other becomes a regular tab, or goes if it
// shows nothing.
export function settleMovedPins(s: BrowserState, windowId: string, pinKeys: Map<string, string>, merging: boolean): BrowserState {
  const tabs = { ...s.tabs };
  let groups = s.groups;
  let tabIds = [...s.windows[windowId]!.tabIds];
  const remove: string[] = [];
  const holderOf = (key: string, profileId: string, not: string) =>
    tabIds.find((id) => id !== not && !remove.includes(id) && tabs[id]?.profileId === profileId && tabs[id]?.pinKey === key && inPinnedContainer({ tabs, groups }, id));
  const demote = (id: string) => {
    const { pinKey: _, ...t } = tabs[id]!;
    tabs[id] = { ...t, pinned: false, pinnedUrl: null };
  };
  for (const [id, key] of pinKeys) {
    const moved = tabs[id];
    const copy = moved && holderOf(key, moved.profileId, id);
    if (!moved || !copy) continue;
    const there = tabs[copy]!;
    if (!moved.unloaded && (there.unloaded || !merging)) {
      // The moved tab takes the copy's place: its row, its group, its pin.
      tabIds = tabIds.filter((t) => t !== id);
      tabIds.splice(tabIds.indexOf(copy), 0, id);
      tabs[id] = { ...moved, pinned: there.pinned, pinnedUrl: there.pinnedUrl, pinKey: key };
      // Out of any group Chrome put it in (an extension moved its whole group), into the copy's.
      groups = leaveGroups(groups, new Set([id]));
      groups = Object.fromEntries(Object.entries(groups).map(([gid, g]) => [gid, g.tabIds.includes(copy) ? { ...g, tabIds: g.tabIds.map((t) => (t === copy ? id : t)) } : g]));
      if (there.unloaded) remove.push(copy);
      else demote(copy);
    } else if (moved.unloaded) remove.push(id);
    else demote(id);
  }
  const w = s.windows[windowId]!;
  const window = { ...w, tabIds: orderSections(pinnedFirst(tabIds, tabs), tabs, groups) };
  const next: BrowserState = { ...s, tabs, groups: syncGroupOrder(groups, window), windows: { ...s.windows, [windowId]: window } };
  return remove.length ? removeTabs(next, remove, false) : next;
}

/** Gives `windowId` the profile's pins as `fromWindowId` has them (before a tab moves between the two). */
export function fillPins(s: BrowserState, windowId: string, profileId: string, fromWindowId: string): BrowserState {
  if (windowId === fromWindowId || !mirrorsPins(s.windows[windowId]) || !mirrorsPins(s.windows[fromWindowId])) return s;
  const next = normalizeKeys(s);
  const sets = pinSets(next).get(profileId) ?? [];
  const canon = sets.find((x) => x.windowId === fromWindowId);
  const mine = sets.find((x) => x.windowId === windowId);
  if (!canon || (!mine && !canon.tiles.length && !canon.groups.length) || mine?.sig === canon.sig) return next;
  return applyPins(next, next, windowId, profileId, canon);
}

const focusRank = (s: BrowserState, x: PinSet) => {
  const i = s.ui.focusOrder.indexOf(x.windowId);
  return i < 0 ? Infinity : i;
};

// The pins of a set whose tab still exists (one the same update removed stays removed).
function alive(set: PinSet, s: BrowserState): PinSet {
  const live = <T extends { tab: string }>(list: T[]) => list.filter((x) => !!s.tabs[x.tab]);
  return withSig({ ...set, tiles: live(set.tiles), groups: set.groups.map((g) => ({ ...g, members: live(g.members) })).filter((g) => g.members.length) });
}

// A pin that changed window in this update (an extension's chrome.tabs.move; the app's own moves are settled in
// moveTabsInto already) is moved, not unpinned: it takes its copy's place in a window that has one, and the window
// it left, if it still shows the profile, gets a copy again.
// `raw` is the update before keys were normalized: a tab moveTabsInto already settled as a regular tab has lost its key.
function settleMoves(prev: BrowserState, raw: BrowserState, s: BrowserState): BrowserState {
  if (prev.tabs === raw.tabs) return s;
  const moved: Tab[] = [];
  for (const t of Object.values(raw.tabs)) {
    const was = prev.tabs[t.id];
    if (was && was.windowId !== t.windowId && was.profileId === t.profileId && was.pinKey && t.pinKey && inPinnedContainer(prev, t.id)) moved.push(t);
  }
  if (!moved.length) return s;
  const held = pinSets(prev);
  const holds = (windowId: string, profileId: string) => !!held.get(profileId)?.some((x) => x.windowId === windowId);
  for (const t of moved) {
    const from = prev.tabs[t.id]!.windowId;
    if (!mirrorsPins(s.windows[t.windowId])) continue;
    // A window new to the profile gets its pins as the window the tab left had them, the moved one's copy included.
    const had = held.get(t.profileId)?.find((x) => x.windowId === from);
    if (!holds(t.windowId, t.profileId) && had) s = applyPins(s, prev, t.windowId, t.profileId, alive(had, s));
    s = settleMovedPins(s, t.windowId, new Map([[t.id, prev.tabs[t.id]!.pinKey!]]), false);
    if (mirrorsPins(s.windows[from])) s = fillPins(s, from, t.profileId, t.windowId);
  }
  return s;
}

/** The store's after-update step: keys for new pins, then each profile's pin edit (or new window) mirrored. */
export function mirrorPins(prev: BrowserState, next: BrowserState): BrowserState {
  if (prev.tabs === next.tabs && prev.groups === next.groups && prev.windows === next.windows) return next;
  next = settleMoves(prev, next, normalizeKeys(next));
  const before = pinSets(prev);
  const base = next;
  for (const [profileId, sets] of pinSets(base)) {
    if (sets.length < 2) continue;
    const old = new Map((before.get(profileId) ?? []).map((x) => [x.windowId, x]));
    const fresh = sets.filter((x) => !old.has(x.windowId));
    const edited = sets.filter((x) => old.has(x.windowId) && old.get(x.windowId)!.sig !== x.sig);
    if (!edited.length && !fresh.length) continue;
    const byFocus = (list: PinSet[]) => [...list].sort((a, z) => focusRank(base, a) - focusRank(base, z));
    // The edit wins (two at once: the focused window's); a window that starts showing the profile adds what it brings.
    let canon = byFocus(edited)[0] ?? byFocus(sets.filter((x) => old.has(x.windowId)))[0] ?? fresh[0]!;
    for (const x of fresh) if (x !== canon) canon = union(canon, x);
    for (const x of sets) if (x.sig !== canon.sig) next = applyPins(next, base, x.windowId, profileId, canon);
  }
  return next;
}

/** A loaded session: keys for pins saved before keys existed (a tile pinned at the same page in two windows is one
 * pin), the park of a profile a window shows taken in, and every window given the union of the profile's pins. */
export function unifyPins(s: BrowserState): BrowserState {
  const windows = s.windowOrder.map((id) => s.windows[id]).filter(mirrorsPins);
  const profiles = new Set(windows.flatMap((w) => [...profilesIn(s, w)]));
  for (const profileId of profiles) {
    const holder = windows.find((w) => profilesIn(s, w).has(profileId));
    if (holder && s.parkedPins[profileId]) s = adoptParkedPins(s, holder.id, profileId);
  }
  const tabs = { ...s.tabs };
  for (const profileId of profiles) {
    const homes: [string, string][] = [];
    // The windows as adoption left them.
    for (const w of windows.map((x) => s.windows[x.id]!)) {
      const own = new Set<string>();
      for (const id of w.tabIds) {
        const t = tabs[id];
        if (!t?.pinned || t.profileId !== profileId) continue;
        const home = t.pinnedUrl || t.url;
        const match = t.pinKey ?? homes.find(([h, k]) => samePage(h, home) && !own.has(k))?.[1];
        const key = match ?? t.id;
        if (!t.pinKey) tabs[id] = { ...t, pinKey: key };
        own.add(key);
        homes.push([home, key]);
      }
    }
  }
  s = normalizeKeys({ ...s, tabs });
  const base = s;
  for (const [profileId, sets] of pinSets(base)) {
    if (sets.length < 2) continue;
    const canon = sets.slice(1).reduce(union, sets[0]!);
    for (const x of sets) if (x.sig !== canon.sig) s = applyPins(s, base, x.windowId, profileId, canon);
  }
  return s;
}
