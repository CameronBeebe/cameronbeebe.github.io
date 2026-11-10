import { cvPassages, maxQuestionLength } from './cv-passages.mjs?v=3';

const panel = document.getElementById('ask-cameron');
const form = panel.querySelector('form');
const input = form.elements.question;
const submit = form.querySelector('button');
const status = panel.querySelector('[role="status"]');
const results = panel.querySelector('.ask-results');
const localLive = ['127.0.0.1', 'localhost'].includes(location.hostname)
  && new URLSearchParams(location.search).has('live-ask');
const endpoint = localLive ? 'http://127.0.0.1:8787/ask' : panel.dataset.endpoint;
const sampleHeadings = { appy: /Appy\.AI/i, phd: /PhD at GSN/i };
const sourceHosts = new Set([
  'arxiv.org', 'cameronbeebe.github.io', 'doi.org', 'edoc.ub.uni-muenchen.de', 'github.com',
  'link.springer.com', 'philsci-archive.pitt.edu', 'www.researchgate.net',
]);
const percentage = value => `${Math.round(value * 100)}%`;

function renderExcerpts(excerpts) {
  results.replaceChildren();
  const more = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = `Show ${excerpts.length - 1} more ${excerpts.length === 2 ? 'match' : 'matches'}`;
  more.append(summary);

  for (const [index, { text, heading, section, source, relevance }] of excerpts.entries()) {
    const quote = document.createElement('blockquote');
    const byline = document.createElement('span');
    byline.className = 'bio-detail';
    if (Number.isFinite(relevance)) {
      byline.textContent = `${percentage(relevance)} match · Jev`;
    }
    const url = new URL(source.url);
    if (url.protocol === 'https:' && sourceHosts.has(url.hostname)) {
      quote.cite = url.href;
      const link = document.createElement('a');
      link.href = url.href;
      const showSection = section && source.label !== 'CV' && heading !== section && !heading.endsWith(' · ' + section);
      const pdfPage = /^#page=(\d+)$/.exec(url.hash)?.[1];
      link.textContent = [source.label, heading, showSection ? section : undefined, pdfPage && `PDF p. ${pdfPage}`]
        .filter(Boolean).join(' · ');
      if (byline.textContent) byline.append(' · ');
      byline.append(link);
    }
    quote.append(byline, text);
    (index === 0 ? results : more).append(quote);
  }
  if (excerpts.length > 1) results.append(more);
}

async function ask(question) {
  if (submit.disabled) return;
  question = question.trim();
  if (!question || question.length > maxQuestionLength) {
    status.textContent = `Enter a question of up to ${maxQuestionLength} characters.`;
    return;
  }
  const sample = endpoint ? undefined : [...input.list.options].find(option => option.value === question)?.dataset.cvSample;
  if (!endpoint && !sample) {
    status.textContent = 'Choose a suggested question in preview mode.';
    return;
  }

  submit.disabled = true;
  renderExcerpts([]);
  status.textContent = endpoint ? 'Checking public sources…' : 'Loading sample excerpts…';
  try {
    let excerpts;
    if (endpoint) {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question }),
        signal: AbortSignal.timeout(24000),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      excerpts = data.excerpts;
    } else {
      const cv = await fetch('./cv.md');
      if (!cv.ok) throw new Error('The CV could not be loaded.');
      excerpts = cvPassages(await cv.text()).filter(({ heading }) => sampleHeadings[sample].test(heading));
    }
    renderExcerpts(excerpts);
    status.textContent = excerpts.length
      ? (endpoint ? 'Top matches · ranked by Jev' : 'Sample answer · excerpts from the public CV')
      : 'No excerpts found in the public sources checked.';
  } catch (error) {
    status.textContent = error instanceof Error && error.name === 'Error' && error.message
      ? error.message : 'Public source lookup is unavailable. Try again shortly.';
  } finally {
    submit.disabled = false;
  }
}

form.addEventListener('submit', event => {
  event.preventDefault();
  ask(input.value);
});

panel.querySelector('.ask-preview').hidden = Boolean(endpoint);
panel.querySelector('.ask-live').hidden = !endpoint;
