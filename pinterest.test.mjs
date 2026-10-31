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
