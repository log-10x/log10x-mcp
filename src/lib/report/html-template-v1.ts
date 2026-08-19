/**
 * template_v1 — the fixed-UX HTML renderer for the POC report.
 *
 * Pure function of ReportData: same data -> byte-identical page
 * (golden-file tested). No clock reads, no randomness, no external
 * assets — one self-contained file, light+dark via
 * prefers-color-scheme. Layout, CSS and tone come from the approved
 * visual mock; every string of content comes from ReportData, and
 * everything is HTML-escaped here.
 */

import { fmtBytes, fmtCount } from '../format.js';
import type {
  CommandBlock,
  EvidenceFace,
  FaceLine,
  ReportAction,
  ReportData,
  VerifyCheck,
} from './report-data.js';

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const CSS = `
:root{--bg:#f2f4f6;--panel:#fff;--sunk:#eaeef2;--line:#dde3e9;--line2:#c8d1da;--ink:#161c23;--dim:#5d6773;--faint:#8b95a1;--val:#8a3f76;--val-bg:#f6ecf3;--bar:#2c3540;--ok:#2e6b4f;--ok-bg:#ddefe6;--wrn:#8a5c10;--skip:#8b95a1}
@media (prefers-color-scheme:dark){:root{--bg:#101419;--panel:#171c22;--sunk:#12161b;--line:#242b34;--line2:#333c47;--ink:#dfe5ec;--dim:#8b96a4;--faint:#6a7481;--val:#d091c0;--val-bg:#2a1e28;--bar:#9aa6b4;--ok:#79b39c;--ok-bg:#1c2b25;--wrn:#d5a445;--skip:#6a7481}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:880px;margin:0 auto;padding:0 22px 90px}
header{padding:44px 0 28px;border-bottom:2px solid var(--line2)}
.eyebrow{display:flex;gap:8px;align-items:center;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);margin:0 0 12px;font-weight:600;flex-wrap:wrap}
.stack{display:inline-flex;gap:6px;margin-left:auto;letter-spacing:.02em;text-transform:none}
.stack span{background:var(--sunk);border:1px solid var(--line);border-radius:4px;padding:2px 8px;font-size:11px;color:var(--dim);font-weight:600}
h1{font-size:clamp(26px,4.2vw,36px);line-height:1.12;letter-spacing:-.022em;font-weight:680;margin:0 0 14px;text-wrap:balance}
.lede{max-width:64ch;color:var(--dim);font-size:14.5px;margin:0 0 8px}
.lede b{color:var(--ink);font-weight:600}
.totals{display:flex;flex-wrap:wrap;gap:28px;margin-top:24px}
.tot b{display:block;font-size:23px;font-weight:660;letter-spacing:-.02em;font-variant-numeric:tabular-nums;line-height:1.15}
.tot span{font-size:11.5px;color:var(--dim)}
.verdict{margin:30px 0 0;padding:20px 22px;background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--val);border-radius:5px}
.verdict h3{margin:0 0 8px;font-size:16.5px;font-weight:650;letter-spacing:-.01em}
.verdict p{margin:0;color:var(--dim);font-size:14px;max-width:72ch}
.split{margin:14px 0 0;display:flex;flex-direction:column;gap:9px}
.split-row{display:flex;align-items:baseline;gap:13px}
.split-pct{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-weight:650;font-size:19px;flex:0 0 auto;min-width:52px;font-variant-numeric:tabular-nums}
.split-pct.lossless{color:var(--ok)}
.split-pct.source{color:var(--wrn)}
.split-lab{color:var(--dim);font-size:13.5px;line-height:1.4}
h2{font-size:12px;letter-spacing:.13em;text-transform:uppercase;color:var(--faint);font-weight:650;margin:50px 0 6px;padding-bottom:9px;border-bottom:1px solid var(--line)}
.sub{max-width:66ch;color:var(--dim);font-size:13.5px;margin:12px 0 4px}
.act{padding:26px 0;border-bottom:1px solid var(--line)}
.ahead{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
.anum{flex:0 0 26px;height:26px;display:inline-flex;align-items:center;justify-content:center;background:var(--bar);color:var(--bg);border-radius:50%;font-size:13px;font-weight:700;align-self:center}
.ahead h3{margin:0;font-size:17.5px;font-weight:650;letter-spacing:-.012em}
.impact{margin-left:auto;font-size:14px;font-weight:650;font-variant-numeric:tabular-nums;color:var(--ok);background:var(--ok-bg);border-radius:4px;padding:3px 10px}
.anote{max-width:70ch;color:var(--dim);font-size:13.5px;margin:10px 0 0}
.annot{max-width:70ch;color:var(--dim);font-size:13px;font-style:italic;margin:6px 0 0}
.alabel{font-size:10px;letter-spacing:.11em;text-transform:uppercase;color:var(--faint);font-weight:650;margin:16px 0 6px}
.face{margin:0 0 4px;background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--line2);border-radius:4px;padding:11px 13px;overflow-x:auto;font:12px/1.7 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.fl{display:block;white-space:pre}
.fl.cont{padding-left:2.2em;color:var(--dim)}
.face .v{font-style:normal;color:var(--val);background:var(--val-bg);border-radius:2px;padding:0 2.5px;font-weight:600}
.face .tab{font-style:normal;color:var(--line2);padding:0 3px}
.more{display:block;margin-top:4px;font-size:11px;color:var(--faint)}
.evm{font-size:11.5px;color:var(--faint);margin:2px 0 10px;font-variant-numeric:tabular-nums}
.evm code{font-size:11px}
.cmd{margin:0;background:var(--sunk);border:1px solid var(--line);border-radius:4px;padding:11px 13px;overflow-x:auto;font:12px/1.65 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--ink);white-space:pre}
.cmd.rb{color:var(--dim)}
code{font:12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.after{display:flex;gap:0;align-items:stretch;margin-top:16px;border:1px solid var(--line);border-radius:5px;overflow:hidden}
.after>div{flex:1;padding:16px 18px;background:var(--panel)}
.after>div+div{border-left:1px solid var(--line)}
.after b{display:block;font-size:22px;font-weight:660;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.after span{font-size:11.5px;color:var(--dim)}
.after .goal b{color:var(--ok)}
.checks{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:8px;margin-top:14px}
.chk{display:flex;gap:9px;align-items:baseline;background:var(--panel);border:1px solid var(--line);border-radius:4px;padding:9px 12px;font-size:12.5px}
.chk i{font-style:normal;font-weight:700}
.chk.ok i{color:var(--ok)} .chk.warn i{color:var(--wrn)} .chk.skip i{color:var(--skip)}
.chk span{color:var(--dim)}
.chk.skip{opacity:.75}
.kept{margin-top:14px;padding:14px 18px;background:var(--panel);border:1px solid var(--line);border-radius:5px;max-width:none}
.kept p{margin:0;font-size:13.5px;color:var(--dim);max-width:72ch}
.kept b{color:var(--ink);font-weight:600}
footer{margin-top:44px;padding-top:18px;border-top:1px solid var(--line);font-size:12.5px;color:var(--faint);max-width:72ch}
footer p{margin:0 0 9px} footer b{color:var(--dim);font-weight:600}
`.trim();

function renderFaceLine(l: FaceLine): string {
  const segs = l.segs
    .map((s) => {
      if (s.t === 'val') return `<i class="v">$</i>`;
      if (s.t === 'tab') return `<i class="tab">&#8677;</i>`;
      return escapeHtml(s.s);
    })
    .join('');
  return `<span class="fl${l.cont ? ' cont' : ''}">${segs}</span>`;
}

function renderFace(f: EvidenceFace): string {
  const lines = f.lines.map(renderFaceLine).join('');
  const more =
    f.elidedLineCount && f.elidedLineCount > 0
      ? `<span class="more">+ ${f.elidedLineCount} more line${f.elidedLineCount === 1 ? '' : 's'} in this statement</span>`
      : '';
  const meta = `<p class="evm">${fmtCount(f.count)} events &middot; ${fmtCount(f.bytesEach)} bytes each &middot; identifier <code>${escapeHtml(f.hash)}</code></p>`;
  return `<pre class="face">${lines}${more}</pre>${meta}`;
}

function renderCommandBlock(label: string, block: CommandBlock, dim: boolean): string {
  const out: string[] = [`<div class="alabel">${escapeHtml(label)}</div>`];
  if (block.commands.length === 0) {
    out.push(
      `<pre class="cmd rb"># ${escapeHtml(block.unavailableNote ?? 'commands not available for this stack in this version')}</pre>`,
    );
  } else {
    out.push(`<pre class="cmd${dim ? ' rb' : ''}">${escapeHtml(block.commands.join('\n'))}</pre>`);
  }
  return out.join('\n');
}

function renderAction(a: ReportAction, n: number): string {
  const impact =
    a.kind === 'operational'
      ? `<span class="impact">operational</span>`
      : a.impactBytes !== undefined
        ? `<span class="impact">&minus;${escapeHtml(fmtBytes(a.impactBytes))} this window</span>`
        : '';
  const parts: string[] = [];
  parts.push(`<article class="act">`);
  parts.push(
    `<div class="ahead"><span class="anum">${n}</span><h3>${escapeHtml(a.title)}</h3>${impact}</div>`,
  );
  parts.push(`<p class="anote">${escapeHtml(a.note)}</p>`);
  if (a.annotation) {
    parts.push(`<p class="annot">${escapeHtml(a.annotation)}</p>`);
  }
  if (a.evidence.length > 0) {
    parts.push(`<div class="alabel">evidence, from your window</div>`);
    for (const f of a.evidence) parts.push(renderFace(f));
    if (a.moreStatements && a.moreStatements > 0) {
      parts.push(
        `<p class="evm">and ${a.moreStatements} more statement${a.moreStatements === 1 ? '' : 's'} in this class</p>`,
      );
    }
  }
  if (a.change) {
    parts.push(`<div class="alabel">the change</div>`);
    const commentLines = a.change.commentLines.map((c) => `# ${c}`);
    const gap = a.change.engineGapNote ? [`# ${a.change.engineGapNote}`] : [];
    parts.push(
      `<pre class="cmd">${escapeHtml([...commentLines, ...gap, ...a.change.rows].join('\n'))}</pre>`,
    );
  }
  if (a.apply) parts.push(renderCommandBlock('apply', a.apply, false));
  if (a.undo) parts.push(renderCommandBlock('undo', a.undo, true));
  if (a.check) parts.push(renderCommandBlock('check', a.check, false));
  parts.push(`</article>`);
  return parts.join('\n');
}

function renderCheck(c: VerifyCheck): string {
  const cls = c.state === 'ok' ? 'ok' : c.state === 'warn' ? 'warn' : 'skip';
  const mark = c.state === 'ok' ? '&#10003;' : c.state === 'warn' ? '!' : '&ndash;';
  const detailBits: string[] = [];
  if (c.detail) detailBits.push(escapeHtml(c.detail));
  if (c.state === 'not_configured' && c.enabledByAction) {
    detailBits.push(`action ${c.enabledByAction} enables it`);
  }
  if (c.state === 'not_run') detailBits.push('not run on this pass');
  const detail = detailBits.length > 0 ? ` <span>&middot; ${detailBits.join(' &middot; ')}</span>` : '';
  return `<div class="chk ${cls}"><i>${mark}</i><div>${escapeHtml(c.label)}${detail}</div></div>`;
}

/** Statements the plan acts on = faces shown + counted-elided ones. */
function statementsCovered(actions: ReportAction[]): number {
  return actions.reduce((s, a) => s + a.evidence.length + (a.moreStatements ?? 0), 0);
}

export function renderReportHtml(data: ReportData): string {
  const d = data;
  const volumeActions = d.actions.filter((a) => a.kind !== 'operational').length;
  const pct = Math.round(d.totals.removablePct);
  // Time-window labels read as "One hour of logs"; the file label already says
  // "this log sample", so appending "of logs" would double the noun.
  const subject = d.window.label === 'this log sample' ? cap(d.window.label) : `${cap(d.window.label)} of logs`;
  // F7: lead with the full addressable total (lossless + fix-at-source) when a
  // dominant cluster sits beside the levers, so the headline matches the agent
  // and the feasibility verdict. "addressable" not "less volume" because part
  // of it is the customer fixing their source, not 10x removing it — the
  // breakdown strip below the hero splits the two.
  const addrPct = d.achievable ? Math.round(d.achievable.totalPct) : pct;
  const h1 =
    volumeActions > 0 && d.achievable
      ? `${subject}, ${d.actions.length} change${d.actions.length === 1 ? '' : 's'}, ${addrPct}% addressable`
      : volumeActions > 0
        ? `${subject}, ${d.actions.length} change${d.actions.length === 1 ? '' : 's'}, ${pct}% less volume`
        : `${subject}, analysed in place`;
  const covered = statementsCovered(d.actions);

  const chips: string[] = [];
  chips.push(`<span>SIEM&nbsp;&middot;&nbsp;${escapeHtml(d.meta.siemLabel ?? 'not set')}</span>`);
  chips.push(
    `<span>forwarder&nbsp;&middot;&nbsp;${escapeHtml(d.meta.forwarderLabel ?? 'not set')}</span>`,
  );

  const totals: string[] = [];
  totals.push(
    `<div class="tot"><b>${escapeHtml(fmtBytes(d.window.ingestedBytes))}</b><span>ingested this window</span></div>`,
  );
  totals.push(
    `<div class="tot"><b>${escapeHtml(fmtBytes(d.totals.removableBytes))}</b><span>removable, this plan</span></div>`,
  );
  totals.push(`<div class="tot"><b>${pct}%</b><span>of current volume</span></div>`);
  if (d.kept.protectedEvents !== null) {
    totals.push(
      `<div class="tot"><b>${fmtCount(d.kept.protectedEvents)}</b><span>errors and warnings kept, all of them</span></div>`,
    );
  }

  const verdictBody = d.verdict.sentences.map((s) => escapeHtml(s)).join(' ');

  // F7 breakdown strip: names the two halves of the addressable total so the
  // hero number can never be read as "10x removes 58%".
  const breakdown = d.achievable
    ? `
<div class="split">
<div class="split-row"><span class="split-pct lossless">${Math.round(d.achievable.losslessPct)}%</span><span class="split-lab">via 10x's lossless levers: offload, compact, or tier down. Nothing deleted.</span></div>
<div class="split-row"><span class="split-pct source">${Math.round(d.achievable.sourceFixPct)}%</span><span class="split-lab">by ${d.achievable.sourceIsFailure ? 'fixing the failure' : 'turning down the repeated output'} at its source. The change is yours to make; 10x measures it.</span></div>
</div>`
    : '';

  const expected = `
<h2>Expected result</h2>
<div class="after">
<div><b>${escapeHtml(fmtBytes(d.expected.beforeBytes))}</b><span>this window</span></div>
<div class="goal"><b>${escapeHtml(fmtBytes(d.expected.afterBytes))}</b><span>after the volume actions, same events</span></div>
<div><b>0</b><span>events deleted</span></div>
</div>
<p class="sub">Apply, let one window pass, and run the analysis again: this report regenerates with a before and after column. That re-run, not this estimate, is the number to take to your team.</p>`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Log10x &mdash; log volume action plan</title>
<style>
${CSS}
</style>
</head>
<body>
<div class="wrap">
<header>
<p class="eyebrow">Log10x &middot; proof of concept, first run
<span class="stack">${chips.join('')}</span></p>
<h1>${escapeHtml(h1)}</h1>
<p class="lede">This window produced <b>${fmtCount(d.window.events)} events</b>. They resolve to <b>${fmtCount(d.window.statements)} distinct log statements</b>; the plan below acts on <b>${covered === 0 ? 'none of them yet' : `${fmtCount(covered)} of them`}</b>.</p>
<div class="totals">
${totals.join('\n')}
</div>
<div class="verdict">
<h3>${escapeHtml(d.verdict.headline)}</h3>
<p>${verdictBody}</p>
</div>
${breakdown}
</header>

<h2>Action plan</h2>
${d.actions.map((a, i) => renderAction(a, i + 1)).join('\n')}
${expected}

<h2>What was verified on this run</h2>
<div class="checks">
${d.verify.map(renderCheck).join('\n')}
</div>
<div class="kept">
<p><b>What this plan does not touch:</b> ${d.kept.sentences.map((s) => escapeHtml(s)).join(' ')}</p>
</div>

<footer>
<p><b>How to read this.</b> A statement is one line of code in one of your services, recognised across every line it produced. <i class="v" style="font-style:normal;color:var(--val);background:var(--val-bg);border-radius:2px;padding:0 2.5px;font-weight:600">$</i> marks a value that varied and was removed. The identifier on each statement is stable across restarts and deployments and works as a query key.</p>
<p><b>Scope.</b> ${escapeHtml(subject)}, analysed in place; no log data left the machine. Figures are this window's arithmetic, not an extrapolation. The re-run after applying is the authoritative measurement.</p>
<p>template ${escapeHtml(d.templateVersion)} &middot; generated ${escapeHtml(d.meta.generatedAtIso)} &middot; log10x-mcp ${escapeHtml(d.meta.mcpVersion)}${d.meta.engineBuild ? ` &middot; ${escapeHtml(d.meta.engineBuild)}` : ''}</p>
</footer>
</div>
</body>
</html>
`;
  return html;
}

function cap(s: string): string {
  return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s;
}
