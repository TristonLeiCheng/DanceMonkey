import fs from "node:fs";

const text = fs.readFileSync(
  "Z:/DanceMonkey/DanceMonkey/Models/DefaultQuickLinks.cs",
  "utf8",
);
const items = [];
const re =
  /Name\s*=\s*"([^"]+)"\s*,\s*Path\s*=\s*"([^"]+)"\s*,\s*Category\s*=\s*"([^"]+)"\s*,\s*Group\s*=\s*"([^"]+)"(?:\s*,\s*Pinned\s*=\s*(true))?/g;
let match;
while ((match = re.exec(text))) {
  items.push({
    name: match[1],
    path: match[2],
    category: match[3],
    group: match[4],
    pinned: Boolean(match[5]),
    description: "",
    clickCount: 0,
    lastClicked: null,
  });
}
fs.writeFileSync(
  new URL("../electron/default-quick-links.json", import.meta.url),
  JSON.stringify(items, null, 2),
);
console.log(JSON.stringify({ count: items.length }));
