import { cvPassages, cvUrl, plainText } from '../assets/cv-passages.mjs';

const lmuUrl = 'https://edoc.ub.uni-muenchen.de/28655/';
const githubApi = 'https://api.github.com';
const githubProfile = 'https://github.com/CameronBeebe';
const featuredRepos = ['fungi_chromatic', 'fungi_fortress', 'scipfs', 'Structural_Idealism'];

async function fetchSource(url, headers) {
  const response = await fetch(url, {
    ...(headers && { headers }),
    signal: AbortSignal.timeout(3000),
    redirect: 'error',
    cf: { cacheEverything: true, cacheTtlByStatus: { '200-299': 900, '400-599': -1 } },
  });
  if (!response.ok) throw new Error('Public source unavailable');
  return response;
}

function githubHeaders(accept = 'application/vnd.github+json') {
  return { Accept: accept, 'User-Agent': 'cameron-portfolio-ask' };
}

async function cv() {
  return cvPassages(await (await fetchSource(cvUrl)).text());
}

const htmlEntities = { amp: '&', apos: "'", quot: '"', lt: '<', gt: '>', nbsp: ' ', ndash: '–', mdash: '—' };

function decodeMetadata(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, name) => {
    if (!name.startsWith('#')) return Object.hasOwn(htmlEntities, name) ? htmlEntities[name] : entity;
    const code = /^#x/i.test(name) ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
    return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  }).replace(/\s+/g, ' ').trim();
}

async function dissertation() {
  const html = await (await fetchSource(lmuUrl)).text();
  const metadata = new Map([...html.matchAll(/<meta\s+name="([^"]+)"\s+content="([^"]*)"/gi)]
    .map(([, name, value]) => [name.toLowerCase(), decodeMetadata(value)]));
  const heading = metadata.get('dc.title');
  const abstract = metadata.get('eprints.abstract_name') ?? metadata.get('dc.description');
  if (!heading || !abstract) return [];

  const sentences = abstract.split(/(?<=[.!?])\s+(?=[A-Z])/);
  const source = { label: 'LMU dissertation abstract', url: lmuUrl };
  const passages = [];
  for (let i = 0; i < sentences.length; i += 3) {
    passages.push({ heading, text: sentences.slice(i, i + 3).join(' '), source });
  }
  return passages;
}

async function githubProjects() {
  const url = `${githubApi}/users/CameronBeebe/repos?type=owner&sort=pushed&direction=desc&per_page=20`;
  const repos = await (await fetchSource(url, githubHeaders())).json();
  const projects = repos.filter(repo => !repo.archived && !repo.private && typeof repo.name === 'string'
    && /^[\w-][\w.-]*$/.test(repo.name) && /^\d{4}-\d\d-\d\dT/.test(repo.pushed_at));
  if (!projects.length) return [];

  const recent = projects.slice(0, 6).map(repo => `${repo.name} (${repo.pushed_at.slice(0, 10)}${repo.fork ? ', fork' : ''})`);
  const recentProjects = projects.filter(repo => !repo.fork && repo.name !== 'cameronbeebe.github.io'
    && !featuredRepos.includes(repo.name)).slice(0, 2);
  const readmes = await Promise.allSettled(recentProjects.map(repo => projectReadme(repo.name)));
  return [
    {
      heading: 'Recently pushed public repositories',
      text: recent.join(' · '),
      source: { label: 'GitHub repository list', url: `${githubProfile}?tab=repositories&sort=pushed` },
    },
    ...projects.map(repo => ({
      heading: repo.name,
      text: [repo.description, `Last push ${repo.pushed_at.slice(0, 10)}.`, repo.fork ? 'Public fork.' : ''].filter(Boolean).join(' '),
      source: { label: 'GitHub repository', url: `${githubProfile}/${encodeURIComponent(repo.name)}` },
    })),
    ...readmes.flatMap(result => result.status === 'fulfilled' ? result.value : []),
  ];
}

async function projectReadme(repo) {
  const url = `${githubApi}/repos/CameronBeebe/${repo}/readme`;
  const markdown = await (await fetchSource(url, githubHeaders('application/vnd.github.raw+json'))).text();
  const intro = markdown.slice(0, 6000).split(/\r?\n##\s/)[0];
  const source = { label: 'GitHub README', url: `${githubProfile}/${repo}#readme` };
  return intro.split(/\r?\n\s*\r?\n/)
    .map(block => block.trim())
    .filter(block => block && !/^(#|<|!\[|\[!\[|```|\|)/.test(block))
    .map(plainText).filter(text => text.length >= 45 && text.length <= 1100)
    .slice(0, 2).map(text => ({ heading: repo, text, source }));
}

const ignoredWords = new Set(['about', 'beebe', 'cameron', 'did', 'does', 'have', 'his', 'the', 'what', 'which', 'with']);
const words = text => (text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).map(word => word.replace(/s$/, ''));

function shortlist(passages, question, limit) {
  const terms = [...new Set(words(question))].filter(word => !ignoredWords.has(word));
  return passages.map(passage => {
    const title = new Set(words(passage.heading));
    const content = new Set(words(passage.text));
    const score = terms.reduce((sum, word) => sum + Number(content.has(word)) + 2 * Number(title.has(word)), 0);
    return { passage, score };
  }).sort((a, b) => b.score - a.score).slice(0, limit).map(({ passage }) => passage);
}

export async function publicPassages(question) {
  const feeds = [
    ['CV', cv], ['LMU dissertation', dissertation], ['GitHub project list', githubProjects],
    ...featuredRepos.map(repo => [`${repo} README`, () => projectReadme(repo)]),
  ];
  const results = await Promise.allSettled(feeds.map(([, load]) => load()));
  const unavailableSources = [];
  const collections = results.map((result, i) => {
    if (result.status === 'fulfilled' && result.value.length) return result.value;
    unavailableSources.push(feeds[i][0]);
    return [];
  });
  const [cvEntries, lmuEntries, ...githubEntries] = collections;
  return {
    passages: [
      ...cvEntries,
      ...shortlist(lmuEntries, question, 4),
      ...shortlist(githubEntries.flat(), question, 9),
    ],
    unavailableSources,
  };
}
