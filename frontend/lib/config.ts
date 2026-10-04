// When the dashboard is served behind the same reverse proxy as the engine
// (production), set NEXT_PUBLIC_SAME_ORIGIN=1 at build time and every call
// goes to the page's own origin.
const SAME_ORIGIN = process.env.NEXT_PUBLIC_SAME_ORIGIN === "1";

export const BACKEND_URL = SAME_ORIGIN
  ? ""
  : (process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://127.0.0.1:8000");

export function streamUrl() {
  if (process.env.NEXT_PUBLIC_STREAM_WS_URL) {
    return process.env.NEXT_PUBLIC_STREAM_WS_URL;
  }
  if (SAME_ORIGIN) {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}/ws/stream`;
  }
  return `${BACKEND_URL.replace(/^http/, "ws")}/ws/stream`;
}
