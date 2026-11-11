"""Index the complete extractable body text of public PDFs by chapter and page."""

import argparse
import json
import re
import subprocess
import unicodedata
from pathlib import Path

import pymupdf


BACK_MATTER = {"bibliography", "references"}
SCRIPT_DIR = Path(__file__).resolve().parent


def clean(text):
    text = unicodedata.normalize("NFKC", text)
    text = re.sub(r"(?<=\w)-[ \t]*\n[ \t]*(?=\w)", "", text).strip()
    # Remove page numbers and running headers at the outer edges.
    text = re.sub(r"^(?:\d+(?: {3,}[^\n]+)?|[^\n]+ {3,}\d+)[ \t]*\n+", "", text)
    return re.sub(r"\n+[ \t]*\d+[ \t]*$", "", text)


def heading_pattern(title):
    title = re.sub(r"^\d+(?:\.\d+)*\s+", "", title)
    words = r"\s+".join(re.escape(word) for word in clean(title).split())
    words = re.sub(r"['‘’`]", "['‘’`]", words)
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
            elif level == 1:
                chapters[-1][1].append((page, 0, 0, title))
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


def page_range(pages, start, stop):
    first_page, first_offset = start
    last_page, last_offset = stop
    for page in range(first_page, min(last_page + 1, len(pages))):
        start_offset = first_offset if page == first_page else 0
        stop_offset = last_offset if page == last_page else len(pages[page])
        text = " ".join(pages[page][start_offset:stop_offset].split())
        if text:
            yield {"page": page + 1, "text": text}


def back_matter_start(pages, start):
    start_page, start_offset = start
    for page in range(start_page, len(pages)):
        offset = start_offset if page == start_page else 0
        match = re.search(r"(?im)^[ \t]*(?:References|Bibliography)[ \t]*$", pages[page][offset:])
        if match:
            return (page, offset + match.start())
    return (len(pages), 0)


def abstract_pages(pages, first_chapter):
    """Recover abstracts that are present in the text without their own bookmark."""
    for page in range(first_chapter[0] + 1):
        end = first_chapter[1] if page == first_chapter[0] else len(pages[page])
        text = pages[page][:end]
        abstract = re.search(r"(?im)^[ \t]*Abstract[ \t]*$", text)
        if abstract:
            contents = re.search(r"(?im)^[ \t]*Contents[ \t]*$", text[abstract.end():])
            stop = (page, abstract.end() + contents.start()) if contents else (page, end)
            return list(page_range(pages, (page, abstract.end()), stop))
    # Some papers have an unlabelled abstract on the introduction page.
    if first_chapter[0] == 0:
        return list(page_range(pages, (0, 0), first_chapter))
    return []


def index_pdf(document, url, label, title, year=None):
    if not document.is_pdf:
        raise ValueError(f"{title} did not return a PDF")
    pages = [clean(page.get_text(sort=True)) for page in document]
    chapters = locate_sections(pages, document.get_toc())

    chapters = [(chapter, sorted(sections)) for chapter, sections in chapters if sections]
    if not chapters:
        chapters = [(title, [(0, 0, 0, title)])]
    last_body = next((sections[0][:2] for chapter, sections in reversed(chapters)
                      if chapter.lower() not in BACK_MATTER), (0, 0))
    end = back_matter_start(pages, last_body)
    source = {"label": label, "url": url}
    if year is not None:
        source["year"] = year
    groups = []
    if chapters[0][0].lower() != "abstract":
        abstract = abstract_pages(pages, chapters[0][1][0][:2])
        if abstract:
            groups.append({"heading": f"{title} · Abstract", "source": source,
                           "sections": [{"heading": "Abstract", "pages": abstract}]})

    for index, (chapter, sections) in enumerate(chapters):
        if chapter.lower() in BACK_MATTER | {"acknowledgements", "acknowledgments", "contents"}:
            continue
        chapter_end = min(end, chapters[index + 1][1][0][:2]) if index + 1 < len(chapters) else end
        indexed_sections = []
        for i, (page, _, body_start, heading) in enumerate(sections):
            stop = min(chapter_end, sections[i + 1][:2]) if i + 1 < len(sections) else chapter_end
            fragments = list(page_range(pages, (page, body_start), stop))
            if fragments:
                indexed_sections.append({"heading": heading, "pages": fragments})
        if indexed_sections:
            heading = f"{title} · {chapter}" if chapter != title else title
            groups.append({"heading": heading, "source": source, "sections": indexed_sections})
    if not groups:
        raise ValueError(f"No selectable body text found in {title}")
    return groups


def open_pdf(source):
    if "file" in source:
        return pymupdf.open(source["file"])
    url = source.get("download", source["url"])
    pdf = subprocess.check_output(["curl", "-fLsS", "--max-time", "30", url])
    return pymupdf.open(stream=pdf, filetype="pdf")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pdf", nargs=4, action="append", metavar=("FILE", "URL", "LABEL", "TITLE"))
    parser.add_argument("--output", type=Path, default=SCRIPT_DIR / "research-index.generated.json")
    args = parser.parse_args()
    if args.pdf:
        sources = [dict(file=file, url=url, label=label, title=title) for file, url, label, title in args.pdf]
    else:
        sources = json.loads((SCRIPT_DIR / "research-sources.json").read_text(encoding="utf-8"))
    groups = []
    for source in sources:
        with open_pdf(source) as document:
            groups.extend(index_pdf(document, source["url"], source["label"], source["title"], source.get("year")))
    args.output.write_text(json.dumps(groups, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    characters = sum(len(page["text"]) for chapter in groups for section in chapter["sections"] for page in section["pages"])
    print(f"Indexed {characters:,} characters across {len(groups)} chapters")


if __name__ == "__main__":
    main()
