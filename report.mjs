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

// Depth-first text rendering of one buildCausality() forest - the dashboard's own tree, indented
// instead of nested <div>s. `id` is a step's primary action id (see session-viz.mjs's shapeEpisode);
// childrenOf keys are the same ids, so a plain object lookup (numeric id, string key - JS coerces)
// walks it without needing a Map.
function causalityLines(viz, id, depth, out) {
  const node = viz.causality.nodes.find((n) => n.id === id);
  if (!node) return;
  const kind = node.causedBy ? ` _(${node.causedBy.kind})_` : '';
  out.push(`${'  '.repeat(depth)}- #${node.id} ${mdEscapeCell(node.type)}${node.target ? ` ${mdEscapeCell(node.target)}` : ''}${node.ok ? '' : ' **FAILED**'}${kind}`);
  for (const childId of viz.causality.childrenOf[id] ?? []) causalityLines(viz, childId, depth + 1, out);
}

// Text/table form of the round-2 dashboard visualizations (session-viz.mjs) - swimlane/state
// machine/episodes/sequence/waste/cost/failure-heatmap/causality/route-FSM all derive from the same
// actions already listed above; this section is what a saved report shows for each instead of
// nothing (a report exported before this section existed had zero trace of any of them). Markdown
// can't render the dashboard's own SVGs, so each gets its table/list form instead - some (state
// machine's insights, cost breakdown's top calls, waste, causality, route FSM) are genuinely new
// information here; others (sequence, most of episodes) are intentionally terse since the Actions
// table above already has the same calls in the same order.
function buildVizSection(viz) {
  const lines = ['## Session visualizations', ''];
  const sm = viz.stateMachine;
  lines.push('### State machine', '');
  lines.push(`${sm.stats.nodes} distinct database state(s), ${sm.stats.edges} transition(s), ${sm.stats.revisits} return(s) to a state already seen, ${sm.stats.noopMutations} no-op write(s).`);
  if (sm.insights.length) { lines.push(''); for (const i of sm.insights) lines.push(`- ${mdEscapeBlock(i)}`); }
  lines.push('');

  lines.push('### Episodes', '');
  lines.push(`${viz.episodes.stats.episodes} episode(s), ${viz.episodes.stats.steps} step(s), ${viz.episodes.stats.failedEpisodes} failed, ${viz.episodes.stats.recoveredEpisodes} recovered.`);
  if (viz.episodes.episodes.length) {
    lines.push('', '| # | Agent | Kind | Outcome | Title |', '|---|---|---|---|---|');
    for (const ep of viz.episodes.episodes) lines.push(`| ${ep.index} | ${mdEscapeCell(ep.agent)} | ${mdEscapeCell(ep.label)} | ${ep.outcome} | ${mdEscapeCell(ep.title)} |`);
  }
  lines.push('');

  lines.push('### Causality', '');
  if (!viz.causality.roots.length) {
    lines.push('_No causal chains - nothing here is a retry, a recovery, or an immediate verify (see Episodes above for the full step list)._');
  } else {
    const out = [];
    for (const rootId of viz.causality.roots) causalityLines(viz, rootId, 0, out);
    lines.push(...out);
  }
  lines.push('');

  lines.push('### Sequence', '');
  lines.push(`${viz.sequence.messages.length} message(s) across ${viz.sequence.stats.participants} agent(s), ${viz.sequence.stats.failed} failed - the dashboard's Sequence panel has the call/return diagram; the Actions table above has the same calls in the same order.`);
  lines.push('');

  lines.push('### Route / page FSM', '');
  if (!viz.routeMachine.nodes.length) {
    lines.push('_No page navigation detected (dom.click\'s own before/after href is the only navigation signal this tool captures)._');
  } else {
    lines.push(`${viz.routeMachine.stats.routes} page(s), ${viz.routeMachine.stats.navigations} navigation(s), ${viz.routeMachine.stats.revisits} return(s) to a page already seen.`);
    lines.push('', '| Page | Visits |', '|---|---|');
    for (const n of viz.routeMachine.nodes) lines.push(`| ${mdEscapeCell(n.route)} | ${n.visits} |`);
    lines.push('', '| Transition | Count |', '|---|---|');
    for (const e of viz.routeMachine.edges) lines.push(`| ${mdEscapeCell(e.from)} → ${mdEscapeCell(e.to)} | ${e.count} |`);
  }
  lines.push('');

  lines.push('### Waste and retries', '');
  const wt = viz.waste.totals;
  lines.push(`${wt.wastedCalls} of ${wt.calls} call(s) bought nothing (${Math.round(wt.wastePct * 100)}%), ${wt.wastedMs}ms spent on failed attempts.`);
  if (viz.waste.retries.length) {
    lines.push('', 'Retries:');
    for (const r of viz.waste.retries) lines.push(`- ${mdEscapeCell(r.type)}${r.target ? ` ${mdEscapeCell(r.target)}` : ''} - ${r.attempts.map((id) => `#${id}`).join(', ')} - ${r.resolvedOk ? 'recovered' : 'never recovered'}`);
  }
  if (viz.waste.duplicateReads.length) {
    lines.push('', 'Duplicate reads (unchanged answer):');
    for (const d of viz.waste.duplicateReads) lines.push(`- ${mdEscapeCell(d.type)}${d.target ? ` ${mdEscapeCell(d.target)}` : ''} - read ${d.count}× (#${d.firstId}, ${d.ids.map((id) => `#${id}`).join(', ')})`);
  }
  if (viz.waste.noopMutations.length) {
    lines.push('', 'No-op writes (ran, changed nothing):');
    for (const n of viz.waste.noopMutations) lines.push(`- #${n.id} ${mdEscapeCell(n.type)}${n.target ? ` ${mdEscapeCell(n.target)}` : ''}`);
  }
  lines.push('');

  lines.push('### Cost breakdown (single most expensive calls)', '');
  lines.push(`${viz.costTree.totalBytes.toLocaleString()} bytes delivered across ${viz.costTree.calls} call(s) (≈ ${viz.costTree.totalTokensEst} tokens) - same total the Token cost table above shows by type.`);
  if (viz.costTree.topCalls.length) {
    lines.push('', '| # | Type | Target | Bytes | Est. tokens |', '|---|---|---|---|---|');
    viz.costTree.topCalls.forEach((t, i) => lines.push(`| ${i + 1} | ${mdEscapeCell(t.type)} | ${mdEscapeCell(t.target)} | ${t.bytes.toLocaleString()} | ${t.tokensEst} |`));
  }
  if (viz.costTree.byAgent.length > 1) {
    lines.push('', '| Agent | Bytes | Share |', '|---|---|---|');
    for (const a of viz.costTree.byAgent) lines.push(`| ${mdEscapeCell(a.agent)} | ${a.bytes.toLocaleString()} | ${Math.round(a.share * 100)}% |`);
  }
  lines.push('');

  lines.push('### Failure heatmap (this session, by time)', '');
  if (!viz.failureHeatmap.totals.calls) {
    lines.push('_No actions recorded._');
  } else {
    const worst = viz.failureHeatmap.worst;
    lines.push(`${viz.failureHeatmap.totals.failed} of ${viz.failureHeatmap.totals.calls} call(s) failed (${Math.round(viz.failureHeatmap.totals.failRate * 100)}%).${worst ? ` Worst: **${mdEscapeCell(worst.type)}** around bucket ${worst.bucket} - ${worst.failed}/${worst.calls} failed.` : ''}`);
  }
  lines.push('');

  return lines;
}

export function buildReportMarkdown({ session, actions, snapshots, diffs, qa, console: consoleEntries, net, verityRuns, tokenReport, repeatedActionLoops, viz, knownIssues, knownIssuesCheckError }) {
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

  if (knownIssuesCheckError) {
    lines.push('## Known issues');
    lines.push('');
    lines.push(`_known-issues.json could not be checked: ${mdEscapeBlock(knownIssuesCheckError)}_`);
    lines.push('');
  } else if (knownIssues?.length) {
    lines.push('## Known issues matched');
    lines.push('');
    lines.push('_Failed actions in this session whose error text matches an entry in the known-issues.json registry - same match an agent already saw live, mid-session, in the failing command\'s own reply._');
    lines.push('');
    lines.push('| Action | Type | Known issue | Remediation |');
    lines.push('|---|---|---|---|');
    for (const k of knownIssues) {
      lines.push(`| #${k.actionId} | ${mdEscapeCell(k.type)} | ${mdEscapeCell(k.knownIssue.id)}${k.knownIssue.description ? ` - ${mdEscapeCell(k.knownIssue.description)}` : ''} | ${mdEscapeCell(k.knownIssue.remediation ?? '')} |`);
    }
    lines.push('');
  }

  // chars/4 estimate over the same result_json every action already
  // stores - the exact bytes a coding agent reading this report (or the
  // session's own printResult output) pays in tokens. Surfaced here so a
  // waste pattern is visible without a separate "token-report" call.
  lines.push('## Token cost (estimated)');
  lines.push('');
  if (!tokenReport?.byType?.length) {
    lines.push('_No actions recorded._');
  } else {
    lines.push(`Total: **${tokenReport.totalCalls}** call(s), **~${tokenReport.totalEstTokens}** estimated tokens.`);
    lines.push('');
    lines.push('| Type | Calls | Avg result bytes | Est. tokens |');
    lines.push('|---|---|---|---|');
    for (const t of tokenReport.byType) {
      lines.push(`| ${mdEscapeCell(t.type)} | ${t.calls} | ${t.avgResultBytes} | ${t.estTokens} |`);
    }
  }
  if (repeatedActionLoops?.length) {
    lines.push('');
    lines.push('**Repeated-call loops flagged** (3+ identical type+params within 5s - likely a poll, not distinct diagnostics):');
    lines.push('');
    for (const l of repeatedActionLoops) {
      lines.push(`- \`${l.type}\` x${l.count} (${l.firstAt} → ${l.lastAt})`);
    }
  }
  lines.push('');

  if (viz) lines.push(...buildVizSection(viz));

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
