// Reads the page the person is on, once, when they open the popup. Runs on their click (activeTab), in that tab only.
// innerText is what is visible on screen: no form values, no hidden text, no page source. The result stays in the popup
// until they press Save.
import { maskNumbers } from "../../api/src/mcp/speak";

export interface PageRead {
  title: string;
  host: string;
  text: string;
}

export const MAX_TEXT = 60_000;

/** Runs inside the page, so it can use nothing from this file. */
const readVisible = (): PageRead => ({
  title: document.title,
  host: location.hostname,
  text: document.body?.innerText ?? "",
});

export const toCapture = (raw: PageRead): PageRead => ({
  title: maskNumbers(raw.title).slice(0, 300),
  host: raw.host,
  text: maskNumbers(raw.text).slice(0, MAX_TEXT),
});

export async function readActivePage(): Promise<PageRead | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return null;
  try {
    const [hit] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readVisible });
    const raw = hit?.result;
    return raw?.host && raw.text.trim() ? toCapture(raw) : null;
  } catch {
    // chrome:// pages, the Web Store and other extensions cannot be read. That is fine, and it needs no detail.
    return null;
  }
}
