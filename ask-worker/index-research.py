"""Build citation-linked excerpts from sectioned, text-based public PDFs."""

import argparse
import json
import re
import unicodedata
from pathlib import Path

import pymupdf


def clean(text):
    text = unicodedata.normalize("NFKC", text)
    return re.sub(r"(?<=\w)-[ \t]*\n[ \t]*(?=\w)", "", text)


def heading_pattern(title):
    title = re.sub(r"^\d+(?:\.\d+)*\s+", "", title)
    words = r"\s+".join(re.escape(word) for word in clean(title).split())
    return rf"(?im)^[ \t]*(?:\d+(?:\.\d+)*[ \t]*)?{words}[ \t]*$"


def locate_sections(pages, outline):
    chapters = []
    if outline:
        for level, title, page_number in outline:
            if level == 1:
                chapters.append((title, []))
            page = page_number - 1
            if not chapters or not 0 <= page < len(pages):
                continue
            match = re.search(heading_pattern(title), pages[page])
            if match:
                chapters[-1][1].append((page, match.start(), match.end(), title))
    else:
        # A table of contents can repeat a heading. Its last occurrence is in the body.
        locations = {}
        for page, text in enumerate(pages):
            for match in re.finditer(r"(?m)^\s*(\d+(?:\.\d+)*)(?: {2,}|\t+)([A-Z][^\n]{2,100})$", text):
                number, title = match.groups()
                locations[number] = (page, match.start(), match.end(), title.strip())
        for number, position in sorted(locations.items(), key=lambda entry: entry[1][:2]):
            if "." not in number:
                chapters.append((position[3], []))
            if chapters:
                chapters[-1][1].append(position)
    return chapters


def index_pdf(path, url, label, title):
    with pymupdf.open(path) as document:
        pages = [clean(page.get_text(sort=True)) for page in document]
        chapters = locate_sections(pages, document.get_toc())

    excerpts = {}
    ordered = sorted(section for _, sections in chapters for section in sections)
    for index, (page, start, body_start, heading) in enumerate(ordered):
        next_page, next_start, *_ = ordered[index + 1] if index + 1 < len(ordered) else (len(pages), 0)
        end = next_start if next_page == page else len(pages[page])
        text = pages[page][body_start:end]
        if len(text.strip()) < 750 and next_page > page and page + 1 < len(pages):
            continuation = pages[page + 1][:next_start if next_page == page + 1 else 850]
            text += "\n" + re.sub(r"^\s*(?:\d+(?: {2,}.*)?|.*? {3,}\d+)[ \t]*\n", "", continuation, count=1)
        text = " ".join(text.split())
        if len(text) < 90:
            continue
        # Prefer a sentence boundary within the excerpt budget.
        sentences = list(re.finditer(r"[.!?](?= [A-Z])", text[:750]))
        stop = sentences[-1].end() if sentences and sentences[-1].end() >= 150 else 0
        excerpt = text[:stop] if stop else text[:750].rsplit(" ", 1)[0] + "…"
        excerpts[(page, start)] = excerpt

    groups = []
    for chapter, sections in chapters:
        if chapter.lower() in {"abstract", "acknowledgements", "bibliography", "references"}:
            continue
        passages = []
        for page, start, _, section in sections:
            text = excerpts.get((page, start))
            if text:
                passages.append({
                    "heading": f"{title} · {chapter}",
                    "section": section,
                    "text": text,
                    "source": {"label": label, "url": f"{url}#page={page + 1}"},
                })
        if passages:
            groups.append(passages)
    if not groups:
        raise ValueError(f"No text sections indexed in {path}")
    return groups


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pdf", nargs=4, action="append", required=True, metavar=("FILE", "URL", "LABEL", "TITLE"))
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    groups = [group for document in args.pdf for group in index_pdf(*document)]
    args.output.write_text(json.dumps(groups, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Indexed {sum(map(len, groups))} passages across {len(groups)} groups")


if __name__ == "__main__":
    main()
