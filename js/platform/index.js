import * as chromeImpl from "./chrome.js";
import * as webImpl from "./web.js";

const isExtension = typeof chrome !== "undefined" && !!chrome.runtime?.id;
const impl = isExtension ? chromeImpl : webImpl;

export const isWebApp = impl.isWebApp;
export const hasTopSites = impl.hasTopSites;

export const storageGet = impl.storageGet;
export const storageSet = impl.storageSet;
export const getAssetUrl = impl.getAssetUrl;
export const getAssetUrlSync = impl.getAssetUrlSync;
export const syncReminders = impl.syncReminders;
export const getTopSites = impl.getTopSites;
export const faviconUrl = impl.faviconUrl;
export const initWebApp = impl.initWebApp || (() => Promise.resolve());

export const snoozeReminder = impl.snoozeReminder || (() => {});
export const dismissReminder = impl.dismissReminder || (() => {});
