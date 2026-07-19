// Pure presentation helpers for Linear workflow states, shared by the ticket
// list and detail panes. The API only exposes the state *name*, so everything
// is keyed off names.

// Linear state names that mean "nothing more is happening here". Closed
// tickets live under their own inbox tab and render muted.
export const CLOSED_STATES = ['Done', 'Canceled', 'Cancelled', 'Closed', 'Duplicate'];

export const isClosed = state => CLOSED_STATES.includes(state);

// antd Tag colors per state name.
const TAG_COLORS = {
  Backlog: 'default',
  Todo: 'gold',
  Triaged: 'geekblue',
  'In Progress': 'processing',
  'In Review': 'cyan',
  Done: 'success',
  Canceled: 'default',
  Cancelled: 'default',
};

export const tagColor = state => TAG_COLORS[state] || 'default';

// antd Badge props (status or preset color) for the list-row status dot.
const DOTS = {
  Backlog: { status: 'default' },
  Todo: { color: 'gold' },
  Triaged: { color: 'geekblue' },
  'In Progress': { status: 'processing' },
  'In Review': { color: 'cyan' },
  Done: { status: 'success' },
  Canceled: { status: 'default' },
  Cancelled: { status: 'default' },
};

export const dotProps = state => DOTS[state] || { status: 'default' };

// Short relative time for list rows and comment headers ("5m ago"), falling
// back to a plain date for anything older than a month.
export const timeAgo = (iso) => {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(then).toLocaleDateString();
};
