#!/usr/bin/env node
// Installs the plugin into Mailspring's packages folder.
//
// Mailspring's own "Developer > Install a Plugin..." copies the whole folder, .git included,
// and git's object files are read-only — so every reinstall after the first fails with
// "EACCES, Permission denied ... \.git\objects". This copies only what the plugin needs.

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONTENTS = ['package.json', 'lib', 'README.md'];

function packagesDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA, 'Mailspring', 'packages');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Mailspring', 'packages');
  }
  const config = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(config, 'Mailspring', 'packages');
}

const source = path.join(__dirname, '..');
const { name } = require(path.join(source, 'package.json'));
const destination = path.join(packagesDir(), name);

fs.rmSync(destination, { recursive: true, force: true });
fs.mkdirSync(destination, { recursive: true });
for (const entry of CONTENTS) {
  fs.cpSync(path.join(source, entry), path.join(destination, entry), { recursive: true });
}

console.log(`Installed ${name} to ${destination}`);
console.log('Restart Mailspring to load it.');
