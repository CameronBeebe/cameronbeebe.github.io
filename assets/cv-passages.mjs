export const maxQuestionLength = 280;

function plainText(markdown) {
  return markdown.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*|\*([^*]+)\*/g, (_, bold, italic) => bold ?? italic)
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ').trim();
}

export function cvPassages(markdown) {
  const passages = [];
  let section;
  let heading;
  let paragraph = [];

  function addPassage(text) {
    if (section && text) passages.push({ section, heading, text: plainText(text) });
  }

  for (const line of markdown.split(/\r?\n/)) {
    const title = /^(#{2,3})\s+(.+)$/.exec(line);
    const bullet = /^-\s+(.+)$/.exec(line);
    if (title || bullet || !line.trim()) {
      addPassage(paragraph.join(' '));
      paragraph = [];
      if (title) {
        if (title[1] === '##') section = plainText(title[2]);
        heading = plainText(title[2]);
      } else if (bullet) {
        addPassage(bullet[1]);
      }
    } else {
      paragraph.push(line);
    }
  }
  addPassage(paragraph.join(' '));
  return passages;
}
