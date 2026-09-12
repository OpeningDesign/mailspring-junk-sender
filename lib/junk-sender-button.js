const { React, Actions, MailRulesStore } = require('mailspring-exports');
const { RetinaImg } = require('mailspring-component-kit');
const { sendersFor, junkSenders, unjunkSenders, isInSpam } = require('./junk-sender');
const PatternPopover = require('./pattern-popover');

// A funnel, since the button creates a filter rule, and a crossed-out funnel for undoing one.
// Mask mode uses only the alpha channel and tints it with the toolbar's icon color, so the
// slash becomes part of the same shape. 16x16 matches the built-in toolbar icons.
const FUNNEL = '<path d="M1.5 2.5h13l-5 6v4.5l-3 1.5v-6z"/>';
const SLASH = '<path d="M2.2 13.1 13.1 2.2l1.4 1.4L3.6 14.5z"/>';

function icon(body) {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">' +
    body +
    '</svg>';
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const ICON_FILTER = icon(FUNNEL);
const ICON_UNDO = icon(FUNNEL + SLASH);

const SHIFT_HINT =
  'Shift-click to match part of the address (like a newsletter name) or a /regular expression/.';

function selectionKey(threads) {
  return threads.map((t) => t.id).join(',');
}

function uniqueRules(senders) {
  const rules = [];
  for (const sender of senders) {
    for (const rule of sender.rules) {
      if (!rules.some((r) => r.id === rule.id)) rules.push(rule);
    }
  }
  return rules;
}

class JunkSenderButton extends React.Component {
  static displayName = 'JunkSenderButton';
  static containerRequired = false;

  state = { senders: [] };

  componentDidMount() {
    this._unlisten = MailRulesStore.listen(() => this._refresh());
    this._refresh();
  }

  componentDidUpdate(prevProps) {
    if (selectionKey(prevProps.items) !== selectionKey(this.props.items)) {
      this._refresh();
    }
  }

  componentWillUnmount() {
    this._unmounted = true;
    this._unlisten();
  }

  async _refresh() {
    const key = selectionKey(this.props.items);
    const senders = await sendersFor(this.props.items);
    // Discard results for a selection that changed while the query ran.
    if (!this._unmounted && key === selectionKey(this.props.items)) {
      this.setState({ senders });
    }
  }

  // Mail sitting in Junk whose sender is already filtered is the one case where the useful
  // action is the opposite one: undo the filtering rather than sweep an Inbox it has left.
  _mode() {
    const { senders } = this.state;
    if (senders.length === 0) return 'none';

    const allInSpam = this.props.items.length > 0 && this.props.items.every(isInSpam);
    const allFiltered = senders.every((s) => s.rules.length > 0);
    return allInSpam && allFiltered ? 'undo' : 'filter';
  }

  _onClick = async (event) => {
    event.stopPropagation();
    const originRect = event.currentTarget.getBoundingClientRect();
    const wantsPattern = event.shiftKey;
    const mode = this._mode();

    const senders = await sendersFor(this.props.items);
    if (senders.length === 0) return;

    if (mode === 'undo') {
      unjunkSenders(senders);
      return;
    }

    if (wantsPattern) {
      const { accountId, email, folder } = senders[0];
      Actions.openPopover(React.createElement(PatternPopover, { accountId, folder, seed: email }), {
        originRect,
        direction: 'down',
      });
      return;
    }

    await junkSenders(senders);
  };

  _undoLines(who, folderName) {
    const rules = uniqueRules(this.state.senders);
    const names = rules.map((r) => `"${r.name}"`).join(', ');
    const count = rules.length === 1 ? 'the rule' : `${rules.length} rules`;
    return [
      `Move this mail back to the Inbox and stop sending ${who} to ${folderName}`,
      `Deletes ${count}: ${names}. A rule matching part of an address can cover other senders too.`,
    ];
  }

  _filterLines(who, folderName) {
    const filtered = this.state.senders.every((s) => s.rules.length > 0);
    const action = filtered
      ? `Move mail from ${who} that's in your Inbox to ${folderName}. A rule already filters their new mail.`
      : `Always move mail from ${who} to ${folderName}, including what's already in your Inbox`;
    return [action, SHIFT_HINT];
  }

  render() {
    const mode = this._mode();
    if (mode === 'none') {
      return null;
    }

    const { senders } = this.state;
    const folderName = senders[0].folder.displayName;
    const who = senders.length === 1 ? senders[0].email : `these ${senders.length} senders`;
    const lines =
      mode === 'undo' ? this._undoLines(who, folderName) : this._filterLines(who, folderName);

    // Native tooltips honour newlines; the screen-reader label stays on one line.
    return React.createElement(
      'button',
      {
        tabIndex: -1,
        className: 'btn btn-toolbar',
        title: lines.join('\n'),
        'aria-label': lines.join(' '),
        onClick: this._onClick,
      },
      React.createElement(RetinaImg, {
        url: mode === 'undo' ? ICON_UNDO : ICON_FILTER,
        mode: RetinaImg.Mode.ContentIsMask,
        'aria-hidden': 'true',
      })
    );
  }
}

module.exports = JunkSenderButton;
