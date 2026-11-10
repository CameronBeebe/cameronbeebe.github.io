import { cvPassages, maxQuestionLength } from './cv-passages.mjs?v=3';

const panel = document.getElementById('ask-cameron');
const form = panel.querySelector('form');
const input = form.elements.question;
const submit = form.querySelector('button');
const status = panel.querySelector('[role="status"]');
const results = panel.querySelector('.ask-results');
const samples = [...panel.querySelectorAll('[data-cv-sample]')];
const localLive = ['127.0.0.1', 'localhost'].includes(location.hostname)
  && new URLSearchParams(location.search).has('live-ask');
const endpoint = panel.dataset.endpoint || (localLive ? 'http://127.0.0.1:8787/ask' : '');
const sampleHeadings = { appy: /Appy\.AI/i, phd: /PhD at GSN/i };
const sourceHosts = new Set(['cameronbeebe.github.io', 'edoc.ub.uni-muenchen.de', 'github.com']);
const percentage = value => `${Math.round(value * 100)}%`;

function renderExcerpts(excerpts) {
  results.replaceChildren();

  for (const { text, heading, source, relevance } of excerpts) {
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
      link.textContent = `${source.label} · ${heading}`;
      if (byline.textContent) byline.append(' · ');
      byline.append(link);
    }
    quote.append(byline, text);
    results.append(quote);
  }
}

async function ask(question, sample) {
  if (submit.disabled) return;
  question = question.trim();
  if (!question || question.length > maxQuestionLength) {
    status.textContent = `Enter a question of up to ${maxQuestionLength} characters.`;
    return;
  }

  submit.disabled = true;
  for (const button of samples) button.disabled = true;
  renderExcerpts([]);
  status.textContent = endpoint ? 'Checking public sources…' : 'Loading sample excerpts…';
  try {
    let excerpts;
    if (endpoint) {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question }),
        signal: AbortSignal.timeout(17000),
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
    for (const button of samples) button.disabled = false;
  }
}

form.addEventListener('submit', event => {
  event.preventDefault();
  ask(input.value);
});
for (const button of samples) {
  button.addEventListener('click', () => {
    input.value = button.textContent.trim();
    ask(input.value, button.dataset.cvSample);
  });
}

form.hidden = !endpoint;
panel.querySelector('.ask-preview').hidden = Boolean(endpoint);
panel.querySelector('.ask-live').hidden = !endpoint;
