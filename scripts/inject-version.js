#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const packageJsonPath = path.join(repoRoot, "package.json");
const uiHtmlPath = path.join(repoRoot, "ui.html");

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const version = String(packageJson.version || "").trim();
if (!version) {
  throw new Error("package.json version is empty.");
}

let html = fs.readFileSync(uiHtmlPath, "utf8");
const original = html;

const semverLike = /[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?/;
const hasLoadingLabel = /<p class="loading-version">\s*Version\s+/i.test(html);
const hasFooterLabels = (html.match(/<span class="version">\s*V\s+/gi) || []).length > 0;

if (!hasLoadingLabel || !hasFooterLabels) {
  throw new Error("Could not find expected version labels in ui.html.");
}

html = html.replace(
  /(<p class="loading-version">\s*)Version\s+[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(\s*<\/p>)/,
  `$1Version ${version}$2`
);

html = html.replace(
  /(<span class="version">\s*)V\s+[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(\s*<\/span>)/g,
  `$1V ${version}$2`
);

if (!semverLike.test(version)) {
  throw new Error(`Version "${version}" does not look like semver.`);
}

if (html !== original) {
  fs.writeFileSync(uiHtmlPath, html, "utf8");
  console.log(`Injected plugin version ${version} into ui.html`);
} else {
  console.log(`ui.html already uses version ${version}`);
}
