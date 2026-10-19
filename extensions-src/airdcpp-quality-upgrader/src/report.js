'use strict';

// The Markdown report (upgrades.md in the extension's settings folder) and the short chat list.

const cell = (text) => String(text === undefined || text === null ? '' : text).replace(/[|\r\n]/g, ' ').slice(0, 200);
const date = (ms) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) : '');

const STATUS_TEXT = {
  found: 'found (report only)',
  queued: 'downloading to staging',
  downloaded: 'downloaded, being put in place',
  placed: 'in place; old copy still there',
  held: 'done; old copy in holding',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
  expired: 'never downloaded',
};

const buildReport = ({ found, jobs, stats, now }) => {
  const lines = [];
  lines.push('# Quality upgrades', '');
  lines.push(`Updated ${date(now)} UTC. Inventory: ${stats.inventory} film(s)/episode(s) from ${stats.mode === 'library' ? 'the media library' : 'the share'}; ${stats.searchesLastHour} search(es) in the last hour.`, '');

  const rows = Object.values(found).sort((a, b) => b.at - a.at);
  if (rows.length === 0) {
    lines.push('No upgrades found yet.');
  } else {
    lines.push('| Found | Have | Better copy | Why | Status | Where the old copy is |', '| --- | --- | --- | --- | --- | --- |');
    for (const f of rows) {
      const job = f.jobId ? jobs[f.jobId] : null;
      const status = job ? (STATUS_TEXT[job.state] || job.state) + (job.note ? ` (${job.note})` : '') : (STATUS_TEXT[f.status] || f.status || 'found') + (f.note ? ` (${f.note})` : '');
      lines.push(`| ${cell(date(f.at))} | ${cell(f.current)} | ${cell(f.candidate)} | ${cell(f.reason)}${f.passive ? ' (seen in another search)' : ''} | ${cell(status)} | ${cell(job && job.heldPath ? job.heldPath : (f.currentPath || ''))} |`);
    }
  }

  lines.push('');
  return lines.join('\n');
};

const chatList = ({ found, jobs }, max = 15) => {
  const rows = Object.values(found).sort((a, b) => b.at - a.at);
  if (rows.length === 0) {
    return [ 'No upgrades found yet.' ];
  }

  const out = rows.slice(0, max).map((f) => {
    const job = f.jobId ? jobs[f.jobId] : null;
    const status = job ? STATUS_TEXT[job.state] || job.state : 'report only';
    return `${f.current} -> ${f.candidate} (${f.reason}; ${status})`;
  });
  if (rows.length > max) {
    out.push(`... and ${rows.length - max} more in upgrades.md`);
  }

  return out;
};

module.exports = { buildReport, chatList, STATUS_TEXT };
