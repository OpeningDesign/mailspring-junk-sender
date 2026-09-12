const { React, Actions, MailRulesStore } = require('mailspring-exports');
const { RetinaImg } = require('mailspring-component-kit');
const { sendersFor, junkSenders } = require('./junk-sender');
const PatternPopover = require('./pattern-popover');

// A funnel, since the button creates a filter rule. Mask mode only uses the alpha channel and
// tints it with the toolbar's icon color. 16x16 matches the built-in toolbar icons.
const ICON_URL = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">' +
    '<path d="M1.5 2.5h13l-5 6v4.5l-3 1.5v-6z"/></svg>'
)}`;

function selectionKey(threads) {
  return threads.map((t) => t.id).join(',');
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

  _onClick = async (event) => {
    event.stopPropagation();
    const originRect = event.currentTarget.getBoundingClientRect();
    const pattern = event.shiftKey;

    const senders = await sendersFor(this.props.items);
    if (senders.length === 0) return;

    if (pattern) {
      const { accountId, email, folder } = senders[0];
      Actions.openPopover(React.createElement(PatternPopover, { accountId, folder, seed: email }), {
        originRect,
        direction: 'down',
      });
      return;
    }

    await junkSenders(senders);
  };

  render() {
    const { senders } = this.state;
    if (senders.length === 0) {
      return null;
    }

    const folderName = senders[0].folder.displayName;
    const who = senders.length === 1 ? senders[0].email : `these ${senders.length} senders`;
    const action = senders.every((s) => s.hasRule)
      ? `Move mail from ${who} that's in your Inbox to ${folderName}. A rule already filters their new mail.`
      : `Always move mail from ${who} to ${folderName}, including what's already in your Inbox`;
    const title = `${action} (Shift-click to match part of the address)`;

    return React.createElement(
      'button',
      {
        tabIndex: -1,
        className: 'btn btn-toolbar',
        title,
        'aria-label': title,
        onClick: this._onClick,
      },
      React.createElement(RetinaImg, {
        url: ICON_URL,
        mode: RetinaImg.Mode.ContentIsMask,
        'aria-hidden': 'true',
      })
    );
  }
}

module.exports = JunkSenderButton;
