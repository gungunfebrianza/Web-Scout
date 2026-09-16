// Web-scout session report builder - pure formatting, no orchestration
// (the GET /sessions/:id/report route in relay.mjs gathers the data, this
// file only turns it into text). Split out for the same reason ai.mjs was:
// relay.mjs is the one file every feature touches, report-building isn't
// an orchestration concern.

function mdEscapeCell(v) {
  if (v == null) return '';
  return String(v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').slice(0, 300);
}

function mdEscapeBlock(v) {
  if (v == null) return '';
  return String(v);
}

export function buildReportMarkdown({ session, actions, snapshots, diffs, qa, console: consoleEntries, net, verityRuns }) {
  const lines = [];
  lines.push(`# Web-scout Session Report: ${session.goal}`);
  lines.push('');
  lines.push(`- **Session:** #${session.id} (${session.status})`);
  if (session.tags?.length) lines.push(`- **Tags:** ${session.tags.map((t) => `\`${t}\``).join(', ')}`);
  if (session.context) lines.push(`- **Context:** ${session.context}`);
  lines.push(`- **Started:** ${session.started_at}${session.ended_at ? `\n- **Ended:** ${session.ended_at}` : ''}`);
  if (session.strict_crv) lines.push('- **Strict-CRV mode:** enabled (every dom.click/dom.fill/eval/idb.put/idb.delete auto-snapshotted before and after)');
  lines.push('');

  lines.push('## Actions');
  lines.push('');
  if (!actions.length) {
    lines.push('_No actions recorded._');
  } else {
    lines.push('| # | Time | Agent | Type | Result | Duration (ms) |');
    lines.push('|---|---|---|---|---|---|');
    const chronological = actions.slice().reverse();
    for (const a of chronological) {
      lines.push(`| ${a.id} | ${a.started_at} | ${a.agent_name ?? 'default'} | ${mdEscapeCell(a.type)} | ${a.ok ? 'ok' : `FAIL: ${mdEscapeCell(a.error)}`} | ${a.duration_ms ?? ''} |`);
    }
  }
  lines.push('');

  lines.push('## State snapshots');
  lines.push('');
  if (!snapshots.length) {
    lines.push('_No snapshots recorded._');
  } else {
    lines.push('| ID | Time | Agent | Counts |');
    lines.push('|---|---|---|---|');
    for (const s of snapshots) {
      const summary = Object.entries(s.counts).filter(([, n]) => n > 0).map(([k, n]) => `${k}:${n}`).join(', ') || '(all empty)';
      lines.push(`| ${s.id} | ${s.taken_at} | ${s.agent_name ?? 'default'} | ${mdEscapeCell(summary)} |`);
    }
  }
  lines.push('');

  lines.push('## State diffs');
  lines.push('');
  if (!diffs.length) {
    lines.push('_No diffs recorded._');
  } else {
    lines.push('| ID | From → To | Summary |');
    lines.push('|---|---|---|');
    for (const d of diffs) {
      const summary = Object.entries(d.summary).map(([store, c]) => `${store}: +${c.added}/-${c.removed}/~${c.changed}`).join(', ') || '(no change)';
      lines.push(`| ${d.id} | ${d.snapshot_from_id} → ${d.snapshot_to_id} | ${mdEscapeCell(summary)} |`);
    }
  }
  lines.push('');

  lines.push('## Console');
  lines.push('');
  if (!consoleEntries?.length) {
    lines.push('_No console entries captured._');
  } else {
    lines.push('| Time | Agent | Level | Message |');
    lines.push('|---|---|---|---|');
    for (const c of consoleEntries) {
      lines.push(`| ${c.occurred_at} | ${c.agent_name} | ${c.level} | ${mdEscapeCell(c.message)} |`);
    }
  }
  lines.push('');

  lines.push('## Network');
  lines.push('');
  if (!net?.length) {
    lines.push('_No network entries captured._');
  } else {
    lines.push('| Time | Agent | Via | Method | URL | Status |');
    lines.push('|---|---|---|---|---|---|');
    for (const n of net) {
      lines.push(`| ${n.occurred_at} | ${n.agent_name} | ${n.via} | ${n.method} | ${mdEscapeCell(n.url)} | ${n.status ?? (n.error ? `ERROR: ${mdEscapeCell(n.error)}` : '')} |`);
    }
  }
  lines.push('');

  lines.push('## Verity UI checks');
  lines.push('');
  lines.push('_Accessibility-tree truth imported from `tools/ui-verifier` (Verity UI Relay) - see the "Relationship to Verity UI Relay" section in docs/web-scout.md._');
  lines.push('');
  if (!verityRuns?.length) {
    lines.push('_No Verity scenario results imported for this session._');
  } else {
    lines.push('| ID | Label | Result | Steps (pass/fail) | Imported |');
    lines.push('|---|---|---|---|---|');
    for (const v of verityRuns) {
      const outcome = v.passed === null ? 'unknown' : (v.passed ? 'PASS' : 'FAIL');
      lines.push(`| ${v.id} | ${mdEscapeCell(v.label)} | ${outcome} | ${v.passed_count}/${v.step_count} (${v.failed_count} failed) | ${v.imported_at} |`);
    }
  }
  lines.push('');

  lines.push('## Q&A');
  lines.push('');
  if (!qa.length) {
    lines.push('_No questions asked._');
  } else {
    for (const q of qa.slice().reverse()) {
      lines.push(`**Q (${q.asked_at}):** ${mdEscapeBlock(q.question)}`);
      lines.push('');
      lines.push(q.answer ? mdEscapeBlock(q.answer) : `_error: ${mdEscapeBlock(q.error)}_`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

export function buildReportJson(bundle) {
  return JSON.stringify(bundle, null, 2);
}
