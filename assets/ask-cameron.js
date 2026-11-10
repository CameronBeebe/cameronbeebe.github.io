import { cvPassages, maxQuestionLength } from './cv-passages.mjs';

const panel = document.getElementById('ask-cameron');
const form = panel.querySelector('form');
const input = form.elements.question;
const submit = form.querySelector('button');
const status = panel.querySelector('[role="status"]');
const results = panel.querySelector('.ask-results');
const sources = panel.querySelector('details');
const sourceList = sources.querySelector('ul');
const samples = [...panel.querySelectorAll('[data-cv-sample]')];
const localLive = ['127.0.0.1', 'localhost'].includes(location.hostname)
  && new URLSearchParams(location.search).has('live-ask');
const endpoint = panel.dataset.endpoint || (localLive ? 'http://127.0.0.1:8787/ask' : '');
const sampleHeadings = { appy: /Appy\.AI/i, phd: /PhD at GSN/i };

function renderExcerpts(excerpts) {
  results.replaceChildren();
  sourceList.replaceChildren();
  sources.hidden = excerpts.length === 0;
  sources.open = false;

  for (const { text } of excerpts) {
    const quote = document.createElement('blockquote');
    quote.textContent = text;
    results.append(quote);
  }

  const headings = new Set(excerpts.map(({ heading }) => heading));
  for (const heading of headings) {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = './cv.md';
    link.textContent = `CV · ${heading}`;
    item.append(link);
    sourceList.append(item);
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
  status.textContent = endpoint ? 'Checking the CV…' : 'Loading sample excerpts…';
  try {
    let excerpts;
    if (endpoint) {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question }),
        signal: AbortSignal.timeout(14000),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      excerpts = data.excerpts;
    } else {
      const cv = await fetch('./cv.md');
      if (!cv.ok) throw new Error('The CV could not be loaded.');
      excerpts = cvPassages(await cv.text()).filter(({ heading }) => sampleHeadings[sample].test(heading)).slice(0, 2);
    }
    renderExcerpts(excerpts);
    status.textContent = excerpts.length
      ? (endpoint ? 'From the public CV · selected by Jev' : 'Sample answer · excerpts from the public CV')
      : 'I couldn’t find an answer in the public CV.';
  } catch (error) {
    status.textContent = error instanceof Error && error.name === 'Error' && error.message
      ? error.message : 'The CV lookup is unavailable. Try again shortly.';
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
