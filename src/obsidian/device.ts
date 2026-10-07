import { Platform, type App } from "obsidian";
import type { DevicePlatform } from "../model/history";
import { isRandomId, randomId } from "../util";

const DEVICE_ID_KEY = "fsrs-vocabulary-device-id";

/**
 * This installation's id, made once and kept in Obsidian's per-vault local storage.
 *
 * Local storage is the point: it stays on the device, where `data.json` would be
 * carried to every other device by the file sync, and every device would then
 * claim the same id and write the same log file.
 */
export function deviceId(app: App): string {
  const stored: unknown = app.loadLocalStorage(DEVICE_ID_KEY);
  if (isRandomId(stored)) return stored;
  const id = randomId();
  app.saveLocalStorage(DEVICE_ID_KEY, id);
  return id;
}

/** Which kind of device this is, for the log file's name. */
export function devicePlatform(): DevicePlatform {
  return Platform.isMobile ? "mobile" : "desktop";
}
