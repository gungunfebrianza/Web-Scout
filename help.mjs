// usage.txt is ~66KB (about 16K tokens). Printing all of it for `cli.mjs`, an unknown
// command, or a mistyped flag made every "what was that flag" cost a screenful. This
// slices it by the structure it already has - a two-space-indented line starting with a
// command word opens an entry, deeper-indented lines continue it - so a caller reads the
// one group or command it asked about.
//
//   help                     the index (topics and their commands), a few hundred tokens
//   help <topic>             every entry of one group: `help idb`, `help session`, `help tokens`
//   help <topic> <sub>       one command: `help idb dump`
//   <command> --help         the same as `help <command> [sub]`
//   help all                 the whole file

import { CLI_SPEC } from './cli-spec.mjs';

const COMMAND_WORDS = new Set(CLI_SPEC.map((s) => s.cmd.split(' ')[0]));
const COMMAND_PATHS = new Set(CLI_SPEC.map((s) => s.cmd));

// Prose blocks that are not commands, by the phrase their first line starts with.
const PROSE_TOPICS = [
  [/^ {2}Reading with fewer tokens/, 'tokens'],
  [/^ {2}Argument checking/, 'notes'],
  [/^ {2}Waste-prevention machinery/, 'notes'],
];
const PROSE_DESCRIPTIONS = {
  tokens: 'reading with fewer tokens: shaping flags, projection, --lean, the token budget, estimator',
  notes: 'argument checking and the waste-prevention machinery that runs automatically',
  global: 'the --agent flag, sessions, relay requirements',
};

export function parseUsage(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const header = lines[0] ?? '';
  const blocks = [];
  let current = null;
  const open = (topic, kind, first) => { current = { topic, kind, lines: [first] }; blocks.push(current); };
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    const command = /^ {2}([a-z][a-z-]*)(\s|$)/.exec(line);
    if (/^\S/.test(line)) { // a column-0 line after the entries: the trailing global notes
      if (current?.topic === 'global') current.lines.push(line);
      else open('global', 'prose', line);
    } else if (command && COMMAND_WORDS.has(command[1])) {
      open(command[1], 'command', line);
    } else if (/^ {2}\S/.test(line)) {
      const prose = PROSE_TOPICS.find(([re]) => re.test(line));
      if (prose) open(prose[1], 'prose', line);
      else if (current) current.lines.push(line); // a paragraph inside the current block
      else open('notes', 'prose', line);
    } else if (current) current.lines.push(line); // blank or deeper-indented continuation
  }
  for (const b of blocks) {
    while (b.lines.length && b.lines[b.lines.length - 1].trim() === '') b.lines.pop();
    b.text = b.lines.join('\n');
    if (b.kind === 'command') {
      const words = b.lines[0].trim().split(/\s+/);
      b.sub = words[1] && COMMAND_PATHS.has(`${words[0]} ${words[1]}`) ? words[1] : null;
    }
  }
  return { header, blocks };
}

const unique = (list) => [...new Set(list)];

export function helpIndex(parsed) {
  const topics = unique(parsed.blocks.filter((b) => b.kind === 'command').map((b) => b.topic));
  const rows = topics.map((t) => {
    const subs = unique(parsed.blocks.filter((b) => b.topic === t && b.kind === 'command' && b.sub).map((b) => b.sub));
    return `  ${t.padEnd(13)}${subs.join(' ')}`;
  });
  const prose = unique(parsed.blocks.filter((b) => b.kind === 'prose').map((b) => b.topic))
    .map((t) => `  ${t.padEnd(13)}${PROSE_DESCRIPTIONS[t] ?? ''}`);
  return [
    parsed.header,
    'Help is sliced so you read only what you need:',
    '  help <topic>            every command in a group, e.g. "help idb"',
    '  help <topic> <sub>      one command, e.g. "help idb dump"   (also: <command> --help)',
    '  help all                everything (~16k tokens)',
    'Commands:',
    ...rows,
    'Other topics:',
    ...prose,
  ].join('\n');
}

// Returns the text for a topic (and optional subcommand), or null when nothing matches.
export function helpTopic(parsed, topic, sub) {
  const t = String(topic ?? '').toLowerCase();
  if (!t || t === 'index') return helpIndex(parsed);
  if (t === 'all') return [parsed.header, ...parsed.blocks.map((b) => b.text)].join('\n');
  let blocks = parsed.blocks.filter((b) => b.topic === t);
  if (!blocks.length) return null;
  if (sub) {
    const wanted = String(sub).toLowerCase();
    blocks = blocks.filter((b) => b.sub === wanted || (b.kind === 'command' && b.lines[0].toLowerCase().includes(`${t} ${wanted}`)));
    if (!blocks.length) return null;
  }
  return blocks.map((b) => b.text).join('\n');
}

export function helpMissing(parsed, topic, sub) {
  const known = unique(parsed.blocks.map((b) => b.topic)).join(', ');
  return `no help for "${[topic, sub].filter(Boolean).join(' ')}" - topics: ${known}. "help" lists them with their commands.`;
}
