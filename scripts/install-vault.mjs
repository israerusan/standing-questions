#!/usr/bin/env node
/**
 * Copies the built add-on into a local test vault. Usage:
 *   VAULT=C:\Users\iavil\second-read-testvault npm run install:vault
 *   npm run install:vault -- C:\Users\iavil\second-read-testvault
 */
import fs from "node:fs";
import path from "node:path";

const vault = process.env.VAULT || process.argv[2];
if (!vault) {
	console.error("Set VAULT=<path to vault> (or pass it as an argument).");
	process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const dest = path.join(vault, ".obsidian", "plugins", manifest.id);
fs.mkdirSync(dest, { recursive: true });
for (const file of ["main.js", "manifest.json", "styles.css"]) {
	fs.copyFileSync(file, path.join(dest, file));
}

// Enable it, without clobbering anything already enabled in this vault.
const listPath = path.join(vault, ".obsidian", "community-plugins.json");
const list = fs.existsSync(listPath) ? JSON.parse(fs.readFileSync(listPath, "utf8")) : [];
if (!list.includes(manifest.id)) {
	list.push(manifest.id);
	fs.writeFileSync(listPath, JSON.stringify(list, null, 2) + "\n");
}

console.log(`installed ${manifest.id} -> ${dest}`);
