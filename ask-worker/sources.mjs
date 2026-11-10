import { cvPassages, cvUrl, plainText } from '../assets/cv-passages.mjs';

const lmuUrl = 'https://edoc.ub.uni-muenchen.de/28655/';
const githubApi = 'https://api.github.com';
const githubProfile = 'https://github.com/CameronBeebe';
const featuredRepos = ['fungi_chromatic', 'fungi_fortress', 'scipfs', 'Structural_Idealism'];

async function fetchSource(url, headers) {
  const response = await fetch(url, {
    ...(headers && { headers }),
    signal: AbortSignal.timeout(3000),
    redirect: 'manual',
    cf: { cacheEverything: true, cacheTtlByStatus: { '200-299': 900, '400-599': -1 } },
  });
  if (!response.ok) throw Object.assign(new Error('Public source unavailable'), { status: response.status });
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
  const encodedRepo = encodeURIComponent(repo);
  const rawUrl = `https://raw.githubusercontent.com/CameronBeebe/${encodedRepo}/HEAD/README.md`;
  let response;
  try {
    response = await fetchSource(rawUrl);
  } catch (error) {
    if (error.status !== 404) throw error;
    // The API can locate READMEs with a different name or path on the default branch.
    const url = `${githubApi}/repos/CameronBeebe/${encodedRepo}/readme`;
    response = await fetchSource(url, githubHeaders('application/vnd.github.raw+json'));
  }
  const markdown = await response.text();
  const intro = markdown.slice(0, 6000).split(/\r?\n##\s/)[0];
  const source = { label: 'GitHub README', url: `${githubProfile}/${encodedRepo}#readme` };
  return intro.split(/\r?\n\s*\r?\n/)
    .map(block => block.trim())
    .filter(block => block && !/^(#|<|!\[|\[!\[|```|\|)/.test(block))
    .map(plainText).filter(text => text.length >= 45 && text.length <= 1100)
    .slice(0, 2).map(text => ({ heading: repo, text, source }));
}

export async function publicPassages() {
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
  if (collections.every(passages => passages.length === 0)) {
    console.error(JSON.stringify({
      message: 'Ask sources yielded no passages',
      sources: results.map((result, i) => ({
        name: feeds[i][0],
        reason: result.status === 'rejected' ? String(result.reason).slice(0, 160) : 'empty',
      })),
    }));
  }
  const projectGroups = new Map();
  for (const passage of githubEntries.flat()) {
    const url = passage.source.url.split('#')[0];
    if (!projectGroups.has(url)) projectGroups.set(url, []);
    projectGroups.get(url).push(passage);
  }
  return {
    referencePassages: [...cvEntries, ...lmuEntries],
    projectGroups: [...projectGroups.values()],
    unavailableSources,
  };
}
