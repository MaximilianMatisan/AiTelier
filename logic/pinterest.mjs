// Reads a public Pinterest board: the customer's style, in pictures they chose.
//
//   node logic/pinterest.mjs https://www.pinterest.com/anna/autumn-looks/
//
// Pinterest publishes an RSS feed for every public profile and board, so this
// needs no login, no API key and no scraping: one feed request per order, then
// the pins' own images. A secret board has no feed and is reported as such.
//
// Every request goes to a fixed list of hosts. The link comes from a customer,
// and a link that redirected anywhere else could make this server fetch an
// internal address on their behalf.
import { fileURLToPath } from "node:url";
import { logger } from "../log.mjs";

/** Hosts a board link may name: pinterest.com, de.pinterest.com, pinterest.co.uk, ... */
const PINTEREST_HOST = /^(?:[a-z]{2,3}\.)?pinterest\.(?:[a-z]{2,3}|co\.uk|com\.au|com\.mx|co\.kr)$/;
const SHORT_HOST = "pin.it";
const IMAGE_HOST = "i.pinimg.com";

/** First path segments that are Pinterest pages, not usernames. */
const RESERVED = new Set([
  "pin", "pins", "search", "ideas", "today", "explore", "business", "settings", "login", "signup",
  "about", "resource", "url_shortener", "categories", "topics", "shopping", "password", "oauth",
  "discover", "news_hub", "notifications", "board", "boards", "_", "videos", "homefeed",
]);
const USERNAME = /^[A-Za-z0-9_]{3,30}$/;
const BOARD = /^[A-Za-z0-9%._-]{1,120}$/;

export const MAX_PINS = 25;
const FEED_MAX_BYTES = 2_000_000;
const IMAGE_MAX_BYTES = 3_000_000;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_REDIRECTS = 5;

const BOARD_HELP = "Send the link of a public Pinterest board, for example https://www.pinterest.com/name/board-name/";
const log = logger("pinterest");

const linkLabel = (link) => {
  try {
    const url = new URL(/^https?:\/\//i.test(link) ? link : `https://${link}`);
    return `${url.hostname}${url.pathname}`;
  } catch {
    return String(link).slice(0, 120);
  }
};

/**
 * The first Pinterest link in a text, as written. Accepts links with or without
 * https:// and pin.it short links; trailing punctuation is not part of it.
 */
export function findPinterestLink(text) {
  const match = String(text ?? "").match(
    /(?<![\w.-])(?:https?:\/\/)?(?:[a-z]{2,3}\.)?pinterest\.[a-z.]{2,6}\/[^\s<>"'()[\]{}]*|(?<![\w.-])(?:https?:\/\/)?pin\.it\/[A-Za-z0-9]+/i,
  );
  const link = match ? match[0].replace(/[.,;:!?]+$/, "") : null;
  if (link) log.info("Pinterest link found", { link: linkLabel(link) });
  return link;
}

/**
 * What a link points at, without touching the network:
 *   { kind: "board", user, board, feed }   one board
 *   { kind: "profile", user, feed }        every pin the user saved recently
 *   { kind: "short", url }                 a pin.it link, resolved when fetched
 *   { error }                              anything else
 */
export function parseBoardLink(link) {
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(link) ? link : `https://${link}`);
  } catch {
    return { error: `"${String(link).slice(0, 80)}" is not a link. ${BOARD_HELP}` };
  }
  const host = url.hostname.toLowerCase();
  if (host === SHORT_HOST) {
    const code = url.pathname.slice(1);
    return /^[A-Za-z0-9]{3,20}$/.test(code)
      ? { kind: "short", url: `https://${SHORT_HOST}/${code}` }
      : { error: `This pin.it link is incomplete. ${BOARD_HELP}` };
  }
  if (!PINTEREST_HOST.test(host)) return { error: `"${host}" is not Pinterest. ${BOARD_HELP}` };
  const [user, board] = url.pathname.split("/").filter(Boolean);
  if (!user) return { error: `This link has no board in it. ${BOARD_HELP}` };
  if (RESERVED.has(user.toLowerCase()))
    return {
      error:
        user.toLowerCase() === "pin"
          ? `This is a link to a single pin, not to a board. ${BOARD_HELP}`
          : `This Pinterest page is not a board. ${BOARD_HELP}`,
    };
  if (!USERNAME.test(user)) return { error: `"${user.slice(0, 40)}" is not a Pinterest username. ${BOARD_HELP}` };
  // /name/_saved/, /name/_created/ and friends are tabs of the profile.
  if (!board || board.startsWith("_"))
    return { kind: "profile", user, feed: `https://www.pinterest.com/${user}/feed.rss` };
  if (!BOARD.test(board)) return { error: `"${board.slice(0, 40)}" is not a board name. ${BOARD_HELP}` };
  return { kind: "board", user, board, feed: `https://www.pinterest.com/${user}/${board}.rss` };
}

const allowedHost = (host, hosts) =>
  hosts.some((allowed) => (allowed instanceof RegExp ? allowed.test(host) : allowed === host));

/**
 * GET with the redirects followed by hand, so every hop is checked against the
 * allowed hosts, and the body read up to a byte limit.
 */
async function guardedGet(url, { fetchImpl, hosts, maxBytes, timeoutMs = 15_000 }) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const parsed = new URL(current);
    if (parsed.protocol !== "https:" || !allowedHost(parsed.hostname.toLowerCase(), hosts))
      throw new Error(`refused to fetch ${parsed.hostname}`);
    const response = await fetchImpl(parsed.href, {
      redirect: "manual",
      headers: { "user-agent": "AiTelier/1.0 (+style reference from a customer's public board)" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`redirect from ${parsed.hostname} without a target`);
      current = new URL(location, parsed).href;
      continue;
    }
    if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
    const declared = Number(response.headers.get("content-length"));
    if (declared > maxBytes) throw new Error(`response larger than ${maxBytes} bytes`);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.length;
      if (size > maxBytes) throw new Error(`response larger than ${maxBytes} bytes`);
      chunks.push(chunk);
    }
    return { url: parsed.href, type: (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase(), body: Buffer.concat(chunks) };
  }
  throw new Error("too many redirects");
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decode(text) {
  return String(text ?? "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === "#") {
      const code = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}
const plain = (html) => decode(String(html).replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
const tag = (xml, name) => xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1] ?? "";

/**
 * The pins in a board feed, newest first, at most `limit`. Each pin's picture
 * is asked for at 736px: the feed links 236px thumbnails, too small to tell a
 * pleat from a crease, and the originals are not public.
 */
export function parseFeed(xml, limit = MAX_PINS) {
  const pins = [];
  for (const [, item] of String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    if (pins.length >= limit) break;
    const html = decode(tag(item, "description").replace(/^<!\[CDATA\[|\]\]>$/g, ""));
    const src = html.match(/<img[^>]+src="([^"]+)"/i)?.[1];
    if (!src) continue;
    let image;
    try {
      image = new URL(src);
    } catch {
      continue;
    }
    if (image.protocol !== "https:" || image.hostname !== IMAGE_HOST) continue;
    image.pathname = image.pathname.replace(/^\/\d+x\//, "/736x/");
    pins.push({
      image: image.href,
      text: plain(html).slice(0, 300),
      title: plain(tag(item, "title")).slice(0, 120),
    });
  }
  return pins;
}

/** A pin.it link is resolved by following its redirects, all within Pinterest. */
async function resolveShort(url, fetchImpl) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const parsed = new URL(current);
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol !== "https:" || !allowedHost(host, [SHORT_HOST, PINTEREST_HOST]))
      throw new Error(`the short link leads to ${host}, not to Pinterest`);
    // The shortener's own hops are /url_shortener/...; the board is where it stops.
    if (PINTEREST_HOST.test(host) && !parsed.pathname.startsWith("/url_shortener/")) {
      const target = parseBoardLink(`https://${host}${parsed.pathname}`);
      if (target.kind === "board" || target.kind === "profile") return target;
    }
    const response = await fetchImpl(parsed.href, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location)
      throw new Error("the short link does not lead to a board");
    current = new URL(location, parsed).href;
  }
  throw new Error("the short link redirects too often");
}

/**
 * The board behind a link and its first pins. Throws with a sentence the
 * customer can act on: a secret board, a pin link, an empty board.
 */
export async function readBoard(link, { fetchImpl = fetch, limit = MAX_PINS } = {}) {
  log.info("Pinterest board read started", { link: linkLabel(link), limit });
  let target = parseBoardLink(link);
  if (target.error) throw new Error(target.error);
  if (target.kind === "short") {
    log.debug("Resolving Pinterest short link", { link: linkLabel(target.url) });
    target = await resolveShort(target.url, fetchImpl);
    log.info("Pinterest short link resolved", { kind: target.kind, board: target.board });
  }
  let feed;
  try {
    feed = await guardedGet(target.feed, { fetchImpl, hosts: [PINTEREST_HOST], maxBytes: FEED_MAX_BYTES });
  } catch (error) {
    log.warn("Pinterest board fetch failed", {
      board: target.board,
      status: error.status,
      reason: String(error?.message ?? error).slice(0, 160),
    });
    if (error.status === 404) throw new Error("This board is not public or does not exist. Secret boards cannot be read.");
    throw new Error(`Pinterest did not answer: ${error.message}`);
  }
  const pins = parseFeed(feed.body.toString("utf8"), limit);
  log.info("Pinterest pins found", { kind: target.kind, board: target.board, pins: pins.length, limit });
  if (!pins.length) throw new Error("This board has no pins with pictures.");
  return { board: { kind: target.kind, user: target.user, board: target.board ?? null }, pins };
}

/**
 * The pins' pictures as bytes, for the model. A picture that fails is skipped:
 * one dead image should not cost the customer the whole board.
 */
export async function downloadImages(pins, { fetchImpl = fetch, concurrency = 5 } = {}) {
  const images = new Array(pins.length).fill(null);
  let next = 0;
  let failed = 0;
  async function worker() {
    while (next < pins.length) {
      const index = next++;
      try {
        const got = await guardedGet(pins[index].image, { fetchImpl, hosts: [IMAGE_HOST], maxBytes: IMAGE_MAX_BYTES });
        if (IMAGE_TYPES.has(got.type)) images[index] = { ...pins[index], bytes: got.body, mediaType: got.type };
        else failed++;
      } catch (error) {
        failed++;
        log.debug("Pinterest image skipped", {
          index: index + 1,
          reason: String(error?.message ?? error).slice(0, 160),
        });
        // skipped; the count of pictures used is reported with the profile
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, pins.length) }, worker));
  const downloaded = images.filter(Boolean);
  log.info("Pinterest images downloaded", { requested: pins.length, downloaded: downloaded.length, skipped: failed });
  return downloaded;
}

async function main() {
  const link = process.argv[2];
  if (!link) {
    console.error("Usage: node logic/pinterest.mjs <board link>");
    process.exitCode = 1;
    return;
  }
  const { board, pins } = await readBoard(link);
  console.log(`${board.kind} ${board.user}${board.board ? `/${board.board}` : ""}: ${pins.length} pins`);
  for (const pin of pins) console.log(`- ${pin.image}  ${pin.text.slice(0, 80)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
