// The gallery: the pictures kept in this browser and how they compare to a connected device.
// No DOM and no Bluetooth in here – see app.js.
//
// A picture ("item"):
//   key         id in this browser
//   name        file name
//   order       position in the gallery
//   original    Blob of the picture as it was added
//   fromDevice  the original is a picture read back from a device (already in display colours)
//   ui          edit settings of the editor
//   renders     display type -> { id, container (Blob), size, w }: the picture file for that display (w: its window)
//   synced      display type -> id that a device was last known to hold for this picture
//   thumb       Blob of the preview

const MAX_TOMBSTONES = 2000;
const MAX_REMOTE_THUMBS = 800;

function newKey() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export class Gallery {
  /** openStore: async () => store (see galleryStore.js). Everything that writes waits for `ready`. */
  constructor(openStore) {
    this.store = null;
    this.items = [];
    this.tombstones = new Set(); // ids to delete on a device at the next sync
    // dirty: changed here, not yet on the device. portrait: how the frame hangs, null = as its display is built
    this.play = { shuffle: false, auto: true, dirty: false, portrait: null };
    this.remoteThumbs = new Map(); // id -> Blob, previews of pictures that are only on a device
    this.deviceState = null; // gallery state of the connected device
    this.deviceList = null; // its pictures in play order, null until read
    this.onChange = () => {};
    this.ready = openStore().then((store) => {
      this.store = store;
      return this._load();
    });
  }

  get persistent() {
    return this.store ? this.store.persistent : true;
  }

  async _load() {
    const [items, remote, play, tombstones] = await Promise.all([this.store.all("items"), this.store.all("remote"), this.store.get("meta", "play"), this.store.get("meta", "tombstones")]);
    this.items = items.sort((a, b) => a.order - b.order);
    // Picture files made before the small window (GALLERY_WINDOW_BITS) need too much memory on
    // the device: they are made again from the original at the next sync.
    for (const item of this.items) {
      for (const [display, render] of Object.entries(item.renders || {})) {
        if (!render.w) delete item.renders[display];
      }
    }
    if (remote.length > MAX_REMOTE_THUMBS) {
      await Promise.all(remote.map((entry) => this.store.remove("remote", entry.id)));
    } else {
      remote.forEach((entry) => this.remoteThumbs.set(entry.id, entry.thumb));
    }
    if (play) this.play = { shuffle: Boolean(play.shuffle), auto: play.auto !== false, dirty: Boolean(play.dirty), portrait: typeof play.portrait === "boolean" ? play.portrait : null };
    if (Array.isArray(tombstones)) this.tombstones = new Set(tombstones);
  }

  // --- pictures -------------------------------------------------------------

  item(key) {
    return this.items.find((item) => item.key === key) || null;
  }

  async add(record) {
    await this.ready;
    const item = {
      key: newKey(),
      name: "Bild",
      addedAt: Date.now(),
      original: null,
      fromDevice: false,
      ui: null,
      renders: {},
      synced: {},
      thumb: null,
      ...record,
      order: this.items.length ? this.items[this.items.length - 1].order + 1 : 0,
    };
    this.items.push(item);
    await this.store.put("items", item);
    await this._reviveIds(item);
    this.onChange();
    return item;
  }

  async update(item) {
    await this.ready;
    await this.store.put("items", item);
    await this._reviveIds(item);
    this.onChange();
  }

  /** A picture that is (again) in the gallery must not be deleted on the device. */
  async _reviveIds(item) {
    let changed = false;
    for (const render of Object.values(item.renders || {})) {
      if (this.tombstones.delete(render.id)) changed = true;
    }
    if (changed) await this._saveTombstones();
  }

  async remove(key) {
    await this.ready;
    const item = this.item(key);
    if (!item) return;
    this.items = this.items.filter((other) => other !== item);
    const ids = [...Object.values(item.renders || {}).map((render) => render.id), ...Object.values(item.synced || {})];
    const stillUsed = this._currentIds();
    ids.filter((id) => id && !stillUsed.has(id)).forEach((id) => this.tombstones.add(id));
    await this.store.remove("items", key);
    await this._saveTombstones();
    this.onChange();
  }

  /** Moves a picture to a position in the gallery (0 = first). */
  async moveTo(key, index) {
    if (!this.store) await this.ready;
    const from = this.items.findIndex((item) => item.key === key);
    if (from < 0) return;
    const target = Math.max(0, Math.min(this.items.length - 1, index));
    if (target === from) return;
    const [item] = this.items.splice(from, 1);
    this.items.splice(target, 0, item);
    const changed = [];
    this.items.forEach((entry, position) => {
      if (entry.order !== position) {
        entry.order = position;
        changed.push(entry);
      }
    });
    this.onChange(); // at once: the next move must see the new order
    await Promise.all(changed.map((entry) => this.store.put("items", entry)));
  }

  // --- pictures that are only on a device -------------------------------------

  /** The user removed a picture that is only on the device: delete it there at the next sync. */
  async forgetRemote(id) {
    await this.ready;
    this.tombstones.add(id);
    await this._saveTombstones();
    this.onChange();
  }

  async dropTombstones(ids) {
    await this.ready;
    let changed = false;
    ids.forEach((id) => {
      if (this.tombstones.delete(id)) changed = true;
    });
    if (changed) await this._saveTombstones();
  }

  async _saveTombstones() {
    if (this.tombstones.size > MAX_TOMBSTONES) {
      this.tombstones = new Set([...this.tombstones].slice(-MAX_TOMBSTONES));
    }
    await this.store.put("meta", [...this.tombstones], "tombstones");
  }

  async putRemoteThumb(id, thumb) {
    await this.ready;
    this.remoteThumbs.set(id, thumb);
    await this.store.put("remote", { id, thumb });
  }

  // --- play settings ----------------------------------------------------------

  async setPlay(patch, { dirty = true } = {}) {
    await this.ready;
    this.play = { ...this.play, ...patch, dirty };
    await this.store.put("meta", this.play, "play");
    this.onChange();
  }

  // --- connected device -------------------------------------------------------

  setDeviceState(state) {
    this.deviceState = state;
  }

  setDeviceList(list) {
    this.deviceList = list;
    this.onChange();
  }

  clearDevice() {
    this.deviceState = null;
    this.deviceList = null;
    this.onChange();
  }

  idFor(item, display) {
    return item.renders?.[display]?.id || null;
  }

  _currentIds() {
    const ids = new Set();
    this.items.forEach((item) => Object.values(item.renders || {}).forEach((render) => ids.add(render.id)));
    return ids;
  }

  _deviceIds() {
    return new Set((this.deviceList || []).map((entry) => entry.id));
  }

  /** "local" (no device list), "synced", "changed" (the device holds an older version) or "new". */
  status(item, display) {
    if (!this.deviceList) return "local";
    const onDevice = this._deviceIds();
    const id = this.idFor(item, display);
    if (id && onDevice.has(id)) return "synced";
    const previous = item.synced?.[display];
    return previous && onDevice.has(previous) ? "changed" : "new";
  }

  /** Pictures of the device that are not in this gallery (and not marked for deletion). */
  remoteOnly(display) {
    if (!this.deviceList) return [];
    const known = new Set();
    this.items.forEach((item) => {
      const id = this.idFor(item, display);
      if (id) known.add(id);
      if (item.synced?.[display]) known.add(item.synced[display]);
    });
    return this.deviceList.filter((entry) => !known.has(entry.id) && !this.tombstones.has(entry.id));
  }

  /** What a sync has to do for this display: { deletes: [id], puts: [item], order: bool, settings: bool } */
  plan(display) {
    const onDevice = this._deviceIds();
    const current = new Set(this.items.map((item) => this.idFor(item, display)).filter(Boolean));
    const deletes = new Set();
    this.tombstones.forEach((id) => {
      if (onDevice.has(id) && !current.has(id)) deletes.add(id);
    });
    const puts = [];
    this.items.forEach((item) => {
      const id = this.idFor(item, display);
      // the version the device still holds of a picture that was edited since
      const previous = item.synced?.[display];
      if (previous && previous !== id && onDevice.has(previous) && !current.has(previous)) deletes.add(previous);
      if (!id || !onDevice.has(id)) puts.push(item);
    });
    return { deletes: [...deletes], puts, order: this.orderDiffers(display), settings: this.play.dirty };
  }

  /** Ids of the gallery pictures that are on the device, in the order of the gallery. */
  orderFor(display, deviceList = this.deviceList) {
    const onDevice = new Set((deviceList || []).map((entry) => entry.id));
    return this.items.map((item) => this.idFor(item, display)).filter((id) => id && onDevice.has(id));
  }

  orderDiffers(display, deviceList = this.deviceList) {
    const wanted = this.orderFor(display, deviceList);
    const wantedSet = new Set(wanted);
    const actual = (deviceList || []).map((entry) => entry.id).filter((id) => wantedSet.has(id));
    return wanted.some((id, index) => actual[index] !== id);
  }
}
