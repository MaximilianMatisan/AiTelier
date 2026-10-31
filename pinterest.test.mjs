import test from "node:test";
import assert from "node:assert/strict";
import { findPinterestLink, parseBoardLink, parseFeed, readBoard, downloadImages, MAX_PINS } from "./logic/pinterest.mjs";

// The shape Pinterest's board feed has: the picture and caption are HTML,
// escaped inside <description>, linking a 236px thumbnail.
const item = (n, { host = "i.pinimg.com", caption = `Pleated trousers ${n}` } = {}) => `
    <item>
      <title> </title>
      <link>https://www.pinterest.com/pin/${1000 + n}/</link>
      <description>&lt;a href=&quot;/pin/${1000 + n}/&quot;&gt;&lt;img src=&quot;https://${host}/236x/aa/bb/cc/pin${n}.jpg&quot;&gt;&lt;/a&gt;${caption}</description>
    </item>`;
const feed = (count, extra = "") =>
  `<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>Board</title>${extra}${Array.from(
    { length: count },
    (_, i) => item(i + 1),
  ).join("")}</channel></rss>`;

/** A fetch that answers from a table of URL -> Response factories, and records every request. */
function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const route = routes[url] ?? Object.entries(routes).find(([k]) => k.endsWith("*") && url.startsWith(k.slice(0, -1)))?.[1];
    if (!route) return new Response("not found", { status: 404 });
    return route(url);
  };
  return { fetchImpl, calls };
}
const xml = (body) => () => new Response(body, { headers: { "content-type": "text/xml; charset=utf-8" } });
const jpeg = () => () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), { headers: { "content-type": "image/jpeg" } });
const redirect = (location) => () => new Response(null, { status: 301, headers: { location } });

const BOARD = "https://www.pinterest.com/anna_b/autumn-looks.rss";

test("a board link is found in a sentence, with or without https and with a pin.it short link", () => {
  assert.equal(findPinterestLink("my board: https://www.pinterest.com/anna_b/autumn-looks/, size M"), "https://www.pinterest.com/anna_b/autumn-looks/");
  assert.equal(findPinterestLink("see de.pinterest.com/anna_b/herbst-looks."), "de.pinterest.com/anna_b/herbst-looks");
  assert.equal(findPinterestLink("pin.it/AbC12xy please"), "pin.it/AbC12xy");
  assert.equal(findPinterestLink("notpinterest.com/anna_b/x"), null, "a lookalike domain is not Pinterest");
  assert.equal(findPinterestLink("two autumn outfits, size M"), null);
});

test("a link names a board, a profile, a short link, or explains what is wrong", () => {
  assert.deepEqual(parseBoardLink("https://de.pinterest.com/anna_b/herbst-looks/?invite=1#x"), {
    kind: "board", user: "anna_b", board: "herbst-looks", feed: "https://www.pinterest.com/anna_b/herbst-looks.rss",
  });
  assert.deepEqual(parseBoardLink("https://pinterest.co.uk/anna_b/"), {
    kind: "profile", user: "anna_b", feed: "https://www.pinterest.com/anna_b/feed.rss",
  });
  assert.equal(parseBoardLink("https://www.pinterest.com/anna_b/_saved/").kind, "profile");
  assert.deepEqual(parseBoardLink("https://pin.it/AbC12xy"), { kind: "short", url: "https://pin.it/AbC12xy" });
  assert.match(parseBoardLink("https://www.pinterest.com/pin/123456/").error, /single pin/);
  assert.match(parseBoardLink("https://www.pinterest.com/search/pins/?q=loafers").error, /not a board/);
  assert.match(parseBoardLink("https://pinterest.com.evil.example/anna_b/x/").error, /is not Pinterest/);
  assert.match(parseBoardLink("https://evil-pinterest.com/anna_b/x/").error, /is not Pinterest/);
  assert.match(parseBoardLink("https://www.pinterest.com/a/x/").error, /username/);
});

test("the feed gives each pin's picture at 736px and its caption, and only Pinterest's own images", () => {
  const pins = parseFeed(feed(2, item(99, { host: "evil.example" })));
  assert.equal(pins.length, 2, "a picture from another host is skipped");
  assert.equal(pins[0].image, "https://i.pinimg.com/736x/aa/bb/cc/pin1.jpg");
  assert.equal(pins[0].text, "Pleated trousers 1");
});

test("no more than the first 25 pins are read", () => {
  assert.equal(MAX_PINS, 25);
  const pins = parseFeed(feed(30));
  assert.equal(pins.length, 25);
  assert.equal(pins[24].text, "Pleated trousers 25", "the first 25, in the board's order");
});

test("a caption keeps its words and loses its markup", () => {
  const [pin] = parseFeed(feed(0, item(1, { caption: "Cable knit &amp;amp; loafers &lt;b&gt;bold&lt;/b&gt;" })));
  assert.equal(pin.text, "Cable knit & loafers bold");
});

test("readBoard reads the board's feed and its pins", async () => {
  const { fetchImpl, calls } = fakeFetch({ [BOARD]: xml(feed(3)) });
  const { board, pins } = await readBoard("https://www.pinterest.com/anna_b/autumn-looks/", { fetchImpl });
  assert.deepEqual(board, { kind: "board", user: "anna_b", board: "autumn-looks" });
  assert.equal(pins.length, 3);
  assert.deepEqual(calls, [BOARD], "one request for the whole board");
});

test("a secret or missing board is said in words the customer can act on", async () => {
  const { fetchImpl } = fakeFetch({});
  await assert.rejects(readBoard("https://www.pinterest.com/anna_b/secret/", { fetchImpl }), /not public or does not exist/);
});

test("a board without pictures is not a style", async () => {
  const { fetchImpl } = fakeFetch({ [BOARD]: xml(feed(0)) });
  await assert.rejects(readBoard("https://www.pinterest.com/anna_b/autumn-looks/", { fetchImpl }), /no pins with pictures/);
});

test("a feed that redirects off Pinterest is refused, not followed", async () => {
  const { fetchImpl, calls } = fakeFetch({ [BOARD]: redirect("http://169.254.169.254/latest/meta-data/") });
  await assert.rejects(readBoard("https://www.pinterest.com/anna_b/autumn-looks/", { fetchImpl }), /refused to fetch 169\.254\.169\.254/);
  assert.deepEqual(calls, [BOARD], "the internal address was never requested");
});

test("a pin.it link is followed through Pinterest's shortener to the board", async () => {
  const { fetchImpl, calls } = fakeFetch({
    "https://pin.it/AbC12xy": redirect("https://www.pinterest.com/url_shortener/abc/redirect/"),
    "https://www.pinterest.com/url_shortener/abc/redirect/": redirect("https://de.pinterest.com/anna_b/autumn-looks/?invite_code=x"),
    [BOARD]: xml(feed(2)),
  });
  const { board, pins } = await readBoard("pin.it/AbC12xy", { fetchImpl });
  assert.equal(board.board, "autumn-looks");
  assert.equal(pins.length, 2);
  assert.equal(calls.at(-1), BOARD);
});

test("a pin.it link that leaves Pinterest is refused", async () => {
  const { fetchImpl } = fakeFetch({ "https://pin.it/AbC12xy": redirect("https://evil.example/anna_b/x/") });
  await assert.rejects(readBoard("https://pin.it/AbC12xy", { fetchImpl }), /leads to evil\.example/);
});

test("a feed larger than the limit is not read into memory", async () => {
  const huge = () => new Response("x".repeat(2_100_000), { headers: { "content-type": "text/xml" } });
  const { fetchImpl } = fakeFetch({ [BOARD]: huge });
  await assert.rejects(readBoard("https://www.pinterest.com/anna_b/autumn-looks/", { fetchImpl }), /larger than/);
});

test("pictures that fail or are not images are skipped, the rest keep their order", async () => {
  const pins = parseFeed(feed(4));
  const { fetchImpl } = fakeFetch({
    [pins[0].image]: jpeg(),
    [pins[1].image]: () => new Response("<html>", { headers: { "content-type": "text/html" } }),
    // pins[2] answers 404
    [pins[3].image]: jpeg(),
  });
  const images = await downloadImages(pins, { fetchImpl });
  assert.deepEqual(images.map((i) => i.text), ["Pleated trousers 1", "Pleated trousers 4"]);
  assert.equal(images[0].mediaType, "image/jpeg");
  assert.ok(Buffer.isBuffer(images[0].bytes));
});

// --- links: what is a board ------------------------------------------------------

test("the first link counts, and the brackets and punctuation around it do not", () => {
  assert.equal(
    findPinterestLink("[my board](https://www.pinterest.com/anna_b/autumn-looks/) and pinterest.com/other_one/x"),
    "https://www.pinterest.com/anna_b/autumn-looks/",
  );
  for (const end of [".", ",", "!", "?", ";", ":"])
    assert.equal(findPinterestLink(`see pinterest.com/anna_b/looks${end}`), "pinterest.com/anna_b/looks", `ending "${end}"`);
  assert.equal(findPinterestLink("(https://pin.it/AbC12xy)"), "https://pin.it/AbC12xy");
  assert.equal(findPinterestLink(null), null);
});

test("a board link keeps working with a section, a query, capitals or an encoded name", () => {
  assert.equal(parseBoardLink("https://www.pinterest.com/anna_b/autumn-looks/knitwear/").board, "autumn-looks", "a section reads its board");
  assert.equal(parseBoardLink("HTTPS://WWW.PINTEREST.COM/anna_b/autumn-looks/").kind, "board");
  assert.equal(parseBoardLink("https://www.pinterest.com/anna_b/herbst-looks-f%C3%BCr-m%C3%A4nner/").kind, "board");
  assert.equal(parseBoardLink("www.pinterest.com/anna_b/autumn-looks/?utm_source=x").feed, BOARD);
  for (const host of ["pinterest.de", "at.pinterest.com", "pinterest.co.uk", "pinterest.com.au", "www.pinterest.ch"])
    assert.equal(parseBoardLink(`https://${host}/anna_b/autumn-looks/`).feed, BOARD, host);
});

test("links that only look like a board are refused with a reason", () => {
  const refused = {
    "https://www.pinterest.com/": /no board in it/,
    "https://www.pinterest.com/ideas/old-money-outfits-men/940848058637/": /not a board/,
    "https://www.pinterest.com/anna.b/autumn/": /not a Pinterest username/,
    "https://www.pinterest.com/anna_b/autumn+looks/": /not a board name/,
    "https://www.pinterest.com/anna_b/a!b/": /not a board name/,
    ["https://www.pinterest.com/" + "a".repeat(31) + "/x/"]: /not a Pinterest username/,
    "https://pin.it/": /incomplete/,
    "https://pin.it/ab/cd": /incomplete/,
    "https://pinterest.evil.example/anna_b/x/": /is not Pinterest/,
    "https://user:pass@evil.example/anna_b/x/": /is not Pinterest/,
    "ftp://www.pinterest.com:21/anna_b/x/": /is not Pinterest|not a link/,
    "not a link at all": /is not Pinterest|not a link/,
  };
  for (const [link, reason] of Object.entries(refused)) {
    assert.match(parseBoardLink(link).error ?? "(accepted)", reason, link);
  }
});

test("markup in a board name stays encoded and only ever reaches Pinterest", () => {
  // The URL parser encodes "<" and ">"; the name can then only 404 at Pinterest.
  const parsed = parseBoardLink("https://www.pinterest.com/anna_b/autumn<script>/");
  assert.ok(!/[<>"]/.test(parsed.board), parsed.board);
  assert.ok(parsed.feed.startsWith("https://www.pinterest.com/anna_b/"));
});

test("every board feed is fetched from www.pinterest.com, whatever domain the link used", () => {
  for (const link of ["de.pinterest.com/anna_b/x/", "https://pinterest.co.uk/anna_b/x/", "https://www.pinterest.ch/anna_b/x/"])
    assert.equal(parseBoardLink(link).feed, "https://www.pinterest.com/anna_b/x.rss");
});

// --- the feed --------------------------------------------------------------------

test("a feed with its description in CDATA reads the same", () => {
  const cdata = `<rss><channel><item><description><![CDATA[<a href="/pin/1/"><img src="https://i.pinimg.com/236x/aa/p1.jpg"></a>Linen shirt]]></description></item></channel></rss>`;
  assert.deepEqual(parseFeed(cdata), [{ image: "https://i.pinimg.com/736x/aa/p1.jpg", text: "Linen shirt", title: "" }]);
});

test("numeric entities are decoded and a long caption is cut", () => {
  const [pin] = parseFeed(feed(0, item(1, { caption: "Men&#39;s &#x201C;quiet luxury&#x201D; " + "x".repeat(400) })));
  assert.ok(pin.text.startsWith("Men's “quiet luxury”"));
  assert.equal(pin.text.length, 300);
});

test("a picture that is not https, not a URL, or not on Pinterest's image host is skipped", () => {
  const bad = (src) => `<item><description>&lt;img src=&quot;${src}&quot;&gt;x</description></item>`;
  const xmlText = `<rss><channel>${[
    bad("http://i.pinimg.com/236x/a.jpg"),
    bad("::not a url::"),
    bad("https://i.pinimg.com.evil.example/236x/a.jpg"),
    bad("https://evil.example/i.pinimg.com/236x/a.jpg"),
    "<item><description>no picture at all</description></item>",
  ].join("")}${item(1)}</channel></rss>`;
  assert.deepEqual(parseFeed(xmlText).map((p) => p.text), ["Pleated trousers 1"]);
});

test("a picture already larger than 236px keeps its path, only the size step changes", () => {
  const [pin] = parseFeed(`<rss><channel><item><description>&lt;img src=&quot;https://i.pinimg.com/474x/aa/236x/p.jpg&quot;&gt;</description></item></channel></rss>`);
  assert.equal(pin.image, "https://i.pinimg.com/736x/aa/236x/p.jpg", "only the leading size segment is replaced");
});

test("the pin limit can be lowered but a feed is never read past it", () => {
  assert.equal(parseFeed(feed(10), 3).length, 3);
  assert.deepEqual(parseFeed("<rss><channel></channel></rss>"), []);
  assert.deepEqual(parseFeed(""), []);
});

// --- fetching --------------------------------------------------------------------

/** A fetch that records each request's options as well as its URL. */
function recordingFetch(routes) {
  const requests = [];
  const { fetchImpl } = fakeFetch(routes);
  return {
    requests,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return fetchImpl(url, init);
    },
  };
}

test("redirects are never followed by fetch itself, so every hop is checked", async () => {
  const pins = parseFeed(feed(2));
  const { fetchImpl, requests } = recordingFetch({ [BOARD]: xml(feed(2)), [pins[0].image]: jpeg(), [pins[1].image]: jpeg() });
  await readBoard("https://www.pinterest.com/anna_b/autumn-looks/", { fetchImpl });
  await downloadImages(pins, { fetchImpl });
  assert.equal(requests.length, 3);
  for (const { url, init } of requests) {
    assert.equal(init.redirect, "manual", url);
    assert.ok(init.signal instanceof AbortSignal, `${url} has a time limit`);
  }
});

test("a redirect to plain http is refused, even on Pinterest", async () => {
  const { fetchImpl } = fakeFetch({ [BOARD]: redirect("http://www.pinterest.com/anna_b/autumn-looks.rss") });
  await assert.rejects(readBoard("https://www.pinterest.com/anna_b/autumn-looks/", { fetchImpl }), /refused to fetch/);
});

test("a redirect within Pinterest is followed", async () => {
  const moved = "https://www.pinterest.com/anna_b/autumn-looks-2.rss";
  const { fetchImpl } = fakeFetch({ [BOARD]: redirect(moved), [moved]: xml(feed(2)) });
  const { pins } = await readBoard("https://www.pinterest.com/anna_b/autumn-looks/", { fetchImpl });
  assert.equal(pins.length, 2);
});

test("a redirect loop ends with an error, not a hang", async () => {
  const other = "https://www.pinterest.com/anna_b/loop.rss";
  const { fetchImpl, calls } = fakeFetch({ [BOARD]: redirect(other), [other]: redirect(BOARD) });
  await assert.rejects(readBoard("https://www.pinterest.com/anna_b/autumn-looks/", { fetchImpl }), /too many redirects/);
  assert.ok(calls.length <= 6, `stopped after ${calls.length} requests`);
});

test("a redirect without a target is an error", async () => {
  const { fetchImpl } = fakeFetch({ [BOARD]: () => new Response(null, { status: 302 }) });
  await assert.rejects(readBoard("https://www.pinterest.com/anna_b/autumn-looks/", { fetchImpl }), /without a target/);
});

test("Pinterest being down or unreachable is said as such", async () => {
  const down = fakeFetch({ [BOARD]: () => new Response("busy", { status: 503 }) });
  await assert.rejects(readBoard("https://www.pinterest.com/anna_b/autumn-looks/", { fetchImpl: down.fetchImpl }), /Pinterest did not answer: HTTP 503/);
  const offline = async () => { throw new TypeError("fetch failed"); };
  await assert.rejects(readBoard("https://www.pinterest.com/anna_b/autumn-looks/", { fetchImpl: offline }), /Pinterest did not answer: fetch failed/);
});

test("a response that announces more bytes than allowed is refused before it is read", async () => {
  let read = false;
  // highWaterMark 0: the stream produces nothing until someone reads it.
  const body = new ReadableStream(
    { pull(controller) { read = true; controller.enqueue(new TextEncoder().encode("<rss>")); controller.close(); } },
    { highWaterMark: 0 },
  );
  const { fetchImpl } = fakeFetch({
    [BOARD]: () => new Response(body, { headers: { "content-type": "text/xml", "content-length": "50000000" } }),
  });
  await assert.rejects(readBoard("https://www.pinterest.com/anna_b/autumn-looks/", { fetchImpl }), /larger than/);
  assert.equal(read, false, "the body was not touched");
});

test("a pin.it link that ends on a single pin is not a board", async () => {
  const { fetchImpl } = fakeFetch({
    "https://pin.it/AbC12xy": redirect("https://www.pinterest.com/pin/123456/"),
    "https://www.pinterest.com/pin/123456/": () => new Response("<html>pin</html>", { headers: { "content-type": "text/html" } }),
  });
  await assert.rejects(readBoard("https://pin.it/AbC12xy", { fetchImpl }), /does not lead to a board/);
});

test("a pin.it link that redirects for ever ends with an error", async () => {
  const { fetchImpl } = fakeFetch({ "https://pin.it/AbC12xy": redirect("https://pin.it/AbC12xy") });
  await assert.rejects(readBoard("https://pin.it/AbC12xy", { fetchImpl }), /redirects too often/);
});

test("a pin.it link to a profile reads the profile's feed", async () => {
  const profileFeed = "https://www.pinterest.com/anna_b/feed.rss";
  const { fetchImpl } = fakeFetch({ "https://pin.it/AbC12xy": redirect("https://de.pinterest.com/anna_b/"), [profileFeed]: xml(feed(4)) });
  const { board, pins } = await readBoard("https://pin.it/AbC12xy", { fetchImpl });
  assert.deepEqual(board, { kind: "profile", user: "anna_b", board: null });
  assert.equal(pins.length, 4);
});

test("readBoard reads no more pins than asked for", async () => {
  const { fetchImpl } = fakeFetch({ [BOARD]: xml(feed(30)) });
  assert.equal((await readBoard("https://www.pinterest.com/anna_b/autumn-looks/", { fetchImpl })).pins.length, 25);
  assert.equal((await readBoard("https://www.pinterest.com/anna_b/autumn-looks/", { fetchImpl, limit: 5 })).pins.length, 5);
});

// --- pictures --------------------------------------------------------------------

test("pictures are fetched five at a time, not all at once", async () => {
  const pins = parseFeed(feed(12));
  let inFlight = 0;
  let peak = 0;
  const fetchImpl = async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight--;
    return new Response(new Uint8Array([1]), { headers: { "content-type": "image/jpeg" } });
  };
  const images = await downloadImages(pins, { fetchImpl });
  assert.equal(images.length, 12);
  assert.equal(peak, 5);
});

test("a picture from another host or over the size limit is skipped", async () => {
  const pins = [
    { image: "https://evil.example/a.jpg", text: "foreign" },
    { image: "https://i.pinimg.com/736x/big.jpg", text: "big" },
    { image: "https://i.pinimg.com/736x/ok.png", text: "ok" },
  ];
  const { fetchImpl, calls } = fakeFetch({
    "https://i.pinimg.com/736x/big.jpg": () => new Response(new Uint8Array(3_100_000), { headers: { "content-type": "image/jpeg" } }),
    "https://i.pinimg.com/736x/ok.png": () => new Response(new Uint8Array([0x89]), { headers: { "content-type": "image/png; charset=binary" } }),
  });
  const images = await downloadImages(pins, { fetchImpl });
  assert.deepEqual(images.map((i) => [i.text, i.mediaType]), [["ok", "image/png"]]);
  assert.ok(!calls.includes("https://evil.example/a.jpg"), "the foreign host was never contacted");
});

test("an image type the model cannot read is skipped", async () => {
  const pins = [{ image: "https://i.pinimg.com/736x/a.svg", text: "svg" }];
  const { fetchImpl } = fakeFetch({ [pins[0].image]: () => new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } }) });
  assert.deepEqual(await downloadImages(pins, { fetchImpl }), []);
});

test("no pins means no requests", async () => {
  const { fetchImpl, calls } = fakeFetch({});
  assert.deepEqual(await downloadImages([], { fetchImpl }), []);
  assert.equal(calls.length, 0);
});
