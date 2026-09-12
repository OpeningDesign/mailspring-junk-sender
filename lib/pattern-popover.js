const { React, Actions, AccountStore } = require('mailspring-exports');
const { matcherFor, scanInbox, junkPattern } = require('./junk-sender');

const h = React.createElement;

const STYLES = {
  container: { padding: 12, width: 380, fontSize: 12 },
  title: { fontWeight: 'bold', marginBottom: 2 },
  input: { width: '100%', fontFamily: 'monospace', marginTop: 8 },
  hint: { marginTop: 6, opacity: 0.7 },
  status: { marginTop: 8 },
  error: { marginTop: 8, color: '#c0392b' },
  buttons: { marginTop: 12, textAlign: 'right' },
  spacer: { marginLeft: 6 },
};

class PatternPopover extends React.Component {
  static displayName = 'JunkSenderPatternPopover';

  constructor(props) {
    super(props);
    this.state = {
      pattern: props.seed || '',
      phase: 'editing',
      scanned: 0,
      matches: [],
      senders: [],
      truncated: false,
      error: null,
    };
  }

  componentDidMount() {
    if (this._input) this._input.select();
  }

  componentWillUnmount() {
    this._unmounted = true;
  }

  _matcher() {
    if (!this.state.pattern.trim()) {
      throw new Error('Enter some text to match.');
    }
    return matcherFor(this.state.pattern);
  }

  _onCheck = async () => {
    let matcher;
    try {
      matcher = this._matcher();
    } catch (err) {
      this.setState({ phase: 'editing', error: err.message });
      return;
    }

    this.setState({ phase: 'checking', error: null, scanned: 0, matches: [], senders: [] });
    const { threads, senders, scanned, truncated } = await scanInbox({
      accountId: this.props.accountId,
      matcher,
      onProgress: ({ scanned: count }) => {
        if (!this._unmounted) this.setState({ scanned: count });
      },
    });
    if (this._unmounted) return;
    this.setState({ phase: 'checked', matches: threads, senders, scanned, truncated });
  };

  _onConfirm = () => {
    let matcher;
    try {
      matcher = this._matcher();
    } catch (err) {
      this.setState({ error: err.message });
      return;
    }
    Actions.closePopover();
    junkPattern({
      accountId: this.props.accountId,
      folder: this.props.folder,
      matcher,
      threads: this.state.matches,
    });
  };

  _onChange = (event) => {
    this.setState({
      pattern: event.target.value,
      phase: 'editing',
      error: null,
      matches: [],
      senders: [],
    });
  };

  _onKeyDown = (event) => {
    if (event.key === 'Escape') {
      Actions.closePopover();
      return;
    }
    if (event.key !== 'Enter' || this.state.phase === 'checking') return;
    event.preventDefault();
    if (this.state.phase === 'checked') {
      this._onConfirm();
    } else {
      this._onCheck();
    }
  };

  _status() {
    const { phase, scanned, matches, senders, truncated } = this.state;

    if (phase === 'checking') {
      return `Scanning your Inbox… ${scanned.toLocaleString()} conversations checked`;
    }
    if (phase !== 'checked') {
      return null;
    }
    if (matches.length === 0) {
      return `Nothing in your Inbox matches. The rule will still catch future mail.`;
    }

    const shown = senders.slice(0, 4).join(', ');
    const more = senders.length > 4 ? `, and ${senders.length - 4} more` : '';
    const cutoff = truncated ? ` Stopped after ${scanned.toLocaleString()} conversations.` : '';
    return `${matches.length.toLocaleString()} in your Inbox match, from ${shown}${more}.${cutoff}`;
  }

  render() {
    const { phase, pattern, matches, error } = this.state;
    const folderName = this.props.folder.displayName;
    const account = AccountStore.accountForId(this.props.accountId);
    const checking = phase === 'checking';

    let confirmLabel = 'Check matches';
    if (phase === 'checked') {
      confirmLabel = matches.length
        ? `Create rule & move ${matches.length.toLocaleString()}`
        : 'Create rule';
    }

    const rows = [
      h('div', { key: 'title', style: STYLES.title }, `Send matching mail to ${folderName}`),
      h('div', { key: 'account', style: STYLES.hint }, account ? account.emailAddress : ''),
      h('input', {
        key: 'input',
        ref: (el) => (this._input = el),
        type: 'text',
        style: STYLES.input,
        value: pattern,
        onChange: this._onChange,
        'aria-label': 'Sender text to match',
      }),
      h(
        'div',
        { key: 'hint', style: STYLES.hint },
        'Matches senders containing this text. Wrap in /…/ for a regular expression.'
      ),
    ];

    if (error) {
      rows.push(h('div', { key: 'error', style: STYLES.error }, error));
    } else {
      const status = this._status();
      if (status) rows.push(h('div', { key: 'status', style: STYLES.status }, status));
    }

    rows.push(
      h('div', { key: 'buttons', style: STYLES.buttons }, [
        h(
          'button',
          { key: 'cancel', className: 'btn', onClick: () => Actions.closePopover() },
          'Cancel'
        ),
        h(
          'button',
          {
            key: 'confirm',
            className: 'btn btn-emphasis',
            style: STYLES.spacer,
            disabled: checking,
            onClick: phase === 'checked' ? this._onConfirm : this._onCheck,
          },
          confirmLabel
        ),
      ])
    );

    // tabIndex is necessary for the popover's onBlur events to work properly
    return h(
      'div',
      {
        tabIndex: -1,
        className: 'junk-sender-popover',
        style: STYLES.container,
        onKeyDown: this._onKeyDown,
      },
      rows
    );
  }
}

module.exports = PatternPopover;
