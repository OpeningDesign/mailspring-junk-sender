const { ComponentRegistry } = require('mailspring-exports');
const JunkSenderButton = require('./junk-sender-button');

function activate() {
  ComponentRegistry.register(JunkSenderButton, { role: 'ThreadActionsToolbarButton' });
}

function deactivate() {
  ComponentRegistry.unregister(JunkSenderButton);
}

module.exports = { activate, deactivate };
