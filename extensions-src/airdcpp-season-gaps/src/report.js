'use strict';

// Turning a check result into the Markdown report file and into short chat lines.

const { episodeCode, compact } = require('./release');

const pad = (n) => String(n).padStart(2, '0');

const isoDay = (ms) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

const stamp = (ms) => {
  const d = new Date(ms);
  return `${isoDay(ms)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
};

// Markdown special characters in a show or episode title must not turn into formatting
const md = (text) => String(text || '').replace(/[\\`*_[\]<>#|]/g, (c) => `\\${c}`).replace(/[\r\n]+/g, ' ');

const missingCount = (show) => show.seasons.reduce((sum, s) => sum + s.missing.length, 0);

// Consecutive numbers collapse: E01-E04, E07
const ranges = (numbers) => {
  const sorted = Array.from(new Set(numbers)).sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(j > i ? `E${pad(sorted[i])}-E${pad(sorted[j])}` : `E${pad(sorted[i])}`);
    i = j + 1;
  }

  return parts.join(', ');
};

const seasonLine = (season) => `S${pad(season.season)}: ${season.whole ? 'whole season, ' : ''}${ranges(season.missing.map((m) => m.episode))}`;

const totals = (result) => {
  const withGaps = result.shows.filter((s) => missingCount(s) > 0);
  return { shows: withGaps.length, episodes: withGaps.reduce((sum, s) => sum + missingCount(s), 0) };
};

const buildMarkdown = (result) => {
  const { shows, episodes } = totals(result);
  const lines = [
    '# Season gaps',
    '',
    `Checked ${stamp(result.at)}: ${result.checkedShows} show(s) in the media library, ${shows} with gaps, ${episodes} aired episode(s) missing.`,
    '',
    `Sources: ${md(result.sourceNote || '')}`,
    '',
  ];

  if (result.notes && result.notes.length > 0) {
    lines.push('## Notes', '');
    for (const note of result.notes) lines.push(`- ${md(note)}`);
    lines.push('');
  }

  const sorted = result.shows.filter((s) => missingCount(s) > 0).sort((a, b) => a.name.localeCompare(b.name));
  for (const show of sorted) {
    lines.push(`## ${md(show.name)}`, '');
    if (show.tmdbId) lines.push(`TMDB: https://www.themoviedb.org/tv/${encodeURIComponent(show.tmdbId)}`, '');
    for (const season of show.seasons) {
      if (season.missing.length === 0) continue;
      lines.push(`- **Season ${season.season}**${season.whole ? ' (none of it is in the library)' : ''}`);
      for (const m of season.missing) {
        lines.push(`  - ${episodeCode(season.season, m.episode)} (${m.airDate || 'no date'})${m.title ? ` ${md(m.title)}` : ''}`);
      }
    }

    lines.push('');
  }

  const skipped = result.shows.filter((s) => s.skipped || s.partial);
  if (skipped.length > 0) {
    lines.push('## Not fully checked', '');
    for (const show of skipped.sort((a, b) => a.name.localeCompare(b.name))) lines.push(`- ${md(show.name)}: ${md(show.skipped || show.partial)}`);
    lines.push('');
  }

  lines.push('Fill one show from a chat window with `/gaps fill <show> [S02]`.', '');
  return lines.join('\n');
};

const summaryText = (result) => {
  const { shows, episodes } = totals(result);
  const unidentified = result.unidentified > 0 ? `; ${result.unidentified} show(s) not identified, see the report` : '';
  return `${shows} show(s) with gaps, ${episodes} aired episode(s) missing (${result.checkedShows} show(s) checked${unidentified})`;
};

// The shows whose name matches what was typed: an exact name first, else a part of the name
const findShows = (result, typed) => {
  const key = compact(typed);
  if (!key || !result) return [];
  const all = result.shows.filter((s) => missingCount(s) > 0);
  const exact = all.filter((s) => (s.keys || [ compact(s.name) ]).includes(key));
  if (exact.length > 0) return exact;
  return all.filter((s) => compact(s.name).includes(key));
};

const showLines = (show, maxLines) => {
  const lines = [ `${show.name}: ${missingCount(show)} missing` ];
  for (const season of show.seasons) {
    if (season.missing.length > 0) lines.push(`  ${seasonLine(season)}`);
  }

  return lines.slice(0, maxLines);
};

const summaryLines = (result, reportPath, maxLines) => {
  if (!result) return [ 'No check has run yet. Type /gaps check to run one now.' ];
  const lines = [ `Last check ${stamp(result.at)}: ${summaryText(result)}.` ];
  const sorted = result.shows.filter((s) => missingCount(s) > 0).sort((a, b) => missingCount(b) - missingCount(a));
  const room = Math.max(1, maxLines - 3);
  for (const show of sorted.slice(0, room)) {
    lines.push(`${show.name}: ${missingCount(show)} missing (${show.seasons.filter((s) => s.missing.length > 0).map(seasonLine).join('; ')})`);
  }

  if (sorted.length > room) {
    lines.push(`... and ${sorted.length - room} more show(s)`);
  }

  lines.push(`Full report: ${reportPath}`);
  return lines;
};

module.exports = { buildMarkdown, summaryText, summaryLines, showLines, findShows, missingCount, ranges, isoDay, stamp, totals };
