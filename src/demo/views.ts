import { NOT_CAPTURED, toView } from '../records.ts';
import type { CallRecord } from '../store.ts';

type View = ReturnType<typeof toView>;

/** Escape caller-controlled text before inserting it into HTML. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const value = (text: string) =>
  text === NOT_CAPTURED || text === 'Not yet classified'
    ? `<span class="missing">${escapeHtml(text)}</span>`
    : escapeHtml(text);

const callState = (view: View) => {
  if (view.callStatus === 'ACTIVE' || view.callStatus === 'TRANSFERRING') return 'In progress';
  return view.outcome === 'INCOMPLETE' ? 'Incomplete' : 'Ended';
};

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/demo/styles.css">
</head>
<body>
<header><a href="/demo">Summit Air · saved calls</a><a class="refresh" href="">Refresh</a></header>
<main>${body}</main>
</body>
</html>`;
}

export function listPage(records: CallRecord[]): string {
  const rows = records.map((record) => {
    const view = toView(record);
    return `<tr>
<td><a href="/demo/calls/${encodeURIComponent(view.id)}">${escapeHtml(view.startedAt)}</a></td>
<td>${escapeHtml(callState(view))}</td>
<td>${value(view.callerName)}</td>
<td>${value(view.issue)}</td>
<td>${value(view.priority)}</td>
<td>${escapeHtml(view.nextStep.label)}</td>
</tr>`;
  });
  const body = records.length
    ? `<table>
<thead><tr><th>Started</th><th>Call</th><th>Caller</th><th>Issue</th><th>Priority</th><th>Next step</th></tr></thead>
<tbody>${rows.join('')}</tbody>
</table>`
    : '<p class="missing">No calls saved yet.</p>';
  return page('Saved calls', `<h1>Recent calls</h1>${body}`);
}

export function detailPage(record: CallRecord): string {
  const view = toView(record);
  const field = (label: string, text: string) => `<dt>${escapeHtml(label)}</dt><dd>${value(text)}</dd>`;
  const reasons = view.priorityReasons.length ? view.priorityReasons.join(', ') : NOT_CAPTURED;
  return page(
    'Call detail',
    `<h1>${escapeHtml(view.startedAt)}</h1>
<p class="next-step">${escapeHtml(view.nextStep.label)}</p>
<section>
<h2>Intake</h2>
<dl>
${field('Issue', view.issue)}
${field('Issue category', view.issueCategory)}
${field('Property type', view.propertyType)}
${field('Name', view.callerName)}
${field('Callback number', view.callbackPhone)}
${field('Service address', view.address)}
${field('Service area', view.serviceArea)}
${field('Availability (caller notes)', view.availability)}
${field('Details confirmed by caller', view.detailsConfirmed)}
</dl>
</section>
<section>
<h2>Priority and actions</h2>
<dl>
${field('Priority', view.priority)}
${field('Reasons', reasons)}
${field('Next step', view.nextStep.label)}
${field('Visit (confirmed appointment)', view.visit)}
${field('Human transfer', view.transfer)}
${field('Emergency guidance', view.emergencyGuidance)}
</dl>
</section>
<section>
<h2>Call</h2>
<dl>
${field('Status', callState(view))}
${field('Started', view.startedAt)}
${field('Ended', view.endedAt ?? NOT_CAPTURED)}
</dl>
</section>
<section>
<h2>Summary</h2>
<p>${value(view.summary)}</p>
<details><summary>Transcript (best effort)</summary>
<p class="note">${escapeHtml(view.transcriptState)}. Covers the AI portion only; a transfer to a representative is not transcribed.</p>
${
  view.transcript.length
    ? `<ol class="transcript">${view.transcript
        .map(
          (turn) => `<li><span class="speaker">${escapeHtml(turn.speaker)}</span> <span class="time">${escapeHtml(turn.time)}</span>
<p>${escapeHtml(turn.text)}</p>${turn.note ? `<p class="note">${escapeHtml(turn.note)}</p>` : ''}</li>`,
        )
        .join('')}</ol>`
    : '<p class="missing">No transcript captured.</p>'
}
</details>
</section>`,
  );
}
