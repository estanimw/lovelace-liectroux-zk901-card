const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const { version, module: bundle } = require(path.join(root, "package.json"));
const filename = path.join(root, bundle);
const source = fs.readFileSync(filename, "utf8");
const placeholder = "@VACUUM_MAP_CARD_VERSION_PLACEHOLDER@";

if (!source.includes(placeholder)) {
    throw new Error("Version placeholder missing. Run npm run build to regenerate the bundle.");
}

fs.writeFileSync(filename, source.replaceAll(placeholder, version));
console.log(`Stamped ${bundle} with v${version}`);
