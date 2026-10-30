// Drops items the customer cannot buy in their own size, before the stylist
// sees them. Without this the stylist picks a sold-out size, Person 3's final
// check rejects the outfit, and the paid order ends in a refund.
//
//   node logic/buyable.mjs --envelope run/person3.input.json --customer run/customer.json
//
// The rule is person3/app/services/resolver.py _size_for_item, applied early:
// the customer's size for the item's layer must be offered (label match,
// ignoring case) and not marked out of stock. Items without sizes, and slots
// the customer gave no size for, are kept, as the resolver accepts them too.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Catalogue category -> the customer.sizes key the resolver will use for it.
const LAYER_FOR = { top: "base", outerwear: "outer", outer: "outer", bottom: "bottom", shoes: "shoes" };

/** Why the item cannot be bought, or null when it can. */
export function unbuyable(item, sizes) {
  const wanted = sizes?.[LAYER_FOR[item.category]];
  if (!wanted || !item.sizes?.length) return null;
  const match = item.sizes.find((s) => String(s.label).toLowerCase() === String(wanted).toLowerCase());
  if (!match) return `size ${wanted} not offered`;
  if (match.in_stock === false) return `size ${wanted} sold out`;
  return null;
}

/** The envelope with unbuyable items removed, plus per-category counts. */
export function keepBuyable(envelope, customer) {
  const sizes = customer.customer?.sizes ?? customer.sizes;
  const counts = {};
  const items = envelope.items.filter((item) => {
    const c = (counts[item.category] ??= { kept: 0, dropped: 0 });
    const reason = unbuyable(item, sizes);
    c[reason ? "dropped" : "kept"] += 1;
    return !reason;
  });
  return { envelope: { ...envelope, items }, counts };
}

async function main() {
  const flag = (name) => {
    const i = process.argv.indexOf(name);
    return i === -1 ? undefined : process.argv[i + 1];
  };
  const envelopePath = flag("--envelope");
  const customer = JSON.parse(await readFile(flag("--customer"), "utf8"));
  const { envelope, counts } = keepBuyable(JSON.parse(await readFile(envelopePath, "utf8")), customer);
  await writeFile(envelopePath, JSON.stringify(envelope, null, 2) + "\n");
  for (const [category, c] of Object.entries(counts))
    console.log(`${category.padEnd(10)} kept ${c.kept}, dropped ${c.dropped}`);
  const empty = Object.entries(counts).filter(([, c]) => c.kept === 0).map(([k]) => k);
  if (empty.length)
    console.log(`\nWARNING: no ${empty.join(" and no ")} left in the customer's size. No complete outfit can be built.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
