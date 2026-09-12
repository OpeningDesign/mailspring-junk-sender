# Junk Sender

A Mailspring plugin for IMAP accounts. Select an email and click the funnel button in the
toolbar to always move mail from its sender to your Junk folder.

Clicking the button:

- Creates a mail rule: **From equals sender → Move Message to folder: Junk**. The rule
  appears in **Preferences → Mail Rules**, where you can edit or delete it.
- Moves the selected email, and every conversation in your Inbox with a message from that
  sender, to Junk. Undo the move from the undo toast; the rule stays until you delete it.

If the sender already has a rule, the button stays available: clicking it moves their
Inbox mail to Junk without creating a second rule. The button is hidden on Gmail
accounts, whose rule editor doesn't offer folder actions.

Mailspring applies rules itself as it syncs new mail, so a blocked sender's email shows up
in your Inbox on other devices until Mailspring has synced it.

## Filtering on part of the address

Senders like `minocquabrewingcompanytimes+weekly-roundup@substack.com` change often, so you
may want to match a fragment instead of the whole address. **Shift-click** the funnel to open
a box holding the sender's address, and edit it down to what you want to match:

- **Plain text** matches any sender *containing* it, ignoring case — `minocquabrewing`
  catches every address and display name with that text in it.
- **`/…/`** is a regular expression — `/^minocqua.*@substack\.com$/`. An invalid expression
  is reported rather than saved.

Matching applies to the sender's display name as well as the address, the same as
Mailspring's own rules. Note that text is matched literally, so `minocquabrewing` does not
match the display name "Minocqua Brewing" — the space is part of the name.

**Check matches** shows how many Inbox conversations match, and which senders, before
anything moves. Confirming saves the pattern as a rule (using the `contains` or
`matches expression` comparator) and moves those conversations to Junk. A pattern can match
far more mail than you expect, so check the count before confirming.

The search index can only match whole words from the start, so patterns are resolved by
paging through your Inbox. That takes longer than the plain-click sweep on a big mailbox,
and stops after 20,000 conversations.

## Install

In Mailspring: **Developer → Install a Plugin…**, then choose this folder.

Installing copies the folder into Mailspring. After changing the plugin, install it again
and restart Mailspring; a plugin that's already running isn't reloaded.

To remove it, delete `%APPDATA%\Mailspring\packages\junk-sender` and restart Mailspring.

## Testing

`npm test` runs the plugin against stand-ins for Mailspring's modules, so it needs only
Node, not Mailspring. It checks the plugin's own logic; the real database, search index,
and toolbar still need a manual check in the app.
