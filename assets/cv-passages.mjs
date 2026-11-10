export const maxQuestionLength = 280;
export const cvUrl = 'https://cameronbeebe.github.io/cv.md';

export function plainText(markdown) {
  return markdown.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*|\*([^*]+)\*/g, (_, bold, italic) => bold ?? italic)
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ').trim();
}

export function cvPassages(markdown) {
  const passages = [];
  let section;
  let heading;
  let entry;
  let paragraph = [];

  function addPassage(text) {
    if (section && text) passages.push({ section, heading, text, source: { label: 'CV', url: cvUrl } });
  }

  function addBlock(text) {
    if (!text) return;
    if (entry) entry.push(plainText(text));
    else addPassage(plainText(text));
  }

  for (const line of markdown.split(/\r?\n/)) {
    const title = /^(#{2,3})\s+(.+)$/.exec(line);
    const bullet = /^-\s+(.+)$/.exec(line);
    if (title || bullet || !line.trim()) {
      addBlock(paragraph.join(' '));
      paragraph = [];
      if (title) {
        if (entry) addPassage(entry.join('\n\n'));
        if (title[1] === '##') section = plainText(title[2]);
        heading = plainText(title[2]);
        entry = title[1] === '###' ? [heading] : undefined;
      } else if (bullet) {
        addBlock(bullet[1]);
      }
    } else {
      paragraph.push(line);
    }
  }
  addBlock(paragraph.join(' '));
  if (entry) addPassage(entry.join('\n\n'));
  return passages;
}
