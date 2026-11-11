"""Frost Date Garden Planner: reproducible printable PDF build. PROPOSED product draft, never sold from here.

    python3 build_kit.py --data kit-data.json --out <dir>

kit-data.json is written by build.ts from data/crops.json and calendar.js (one source of truth for dates).
Outputs, for US Letter and A4:
  frost-date-garden-planner.<paper>.pdf        the kit (fill-in calendar worksheet works with any frost date)
  personal-calendar.sample-<zip>.<paper>.pdf   the personal sheet for one frost date (sample, clearly labelled)
Uses only the PDF base fonts (no font files, no images), and reportlab's invariant mode so the same input gives the
same bytes.
"""
import argparse
import json
import os

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, letter
from reportlab.lib.units import inch, mm
from reportlab.pdfgen import canvas

INK = colors.HexColor("#22281F")
MUTED = colors.HexColor("#525C4C")
LINE = colors.HexColor("#B9B6A4")
ACCENT = colors.HexColor("#3D6A2C")
SOFT = colors.HexColor("#E6EDD6")
PAPERS = {"letter": letter, "a4": A4}


class Doc:
    def __init__(self, path, paper, title, subject):
        self.w, self.h = PAPERS[paper]
        self.paper = paper
        self.c = canvas.Canvas(path, pagesize=(self.w, self.h), invariant=1, pageCompression=1)
        self.c.setTitle(title)
        self.c.setAuthor("Frost Date Planting")
        self.c.setSubject(subject)
        self.c.setCreator("FORGE builder kit/build_kit.py")
        self.m = 0.6 * inch
        self.page_no = 0
        self.footer_text = title

    def page(self, heading, sub=None):
        if self.page_no:
            self.c.showPage()
        self.page_no += 1
        c = self.c
        c.setFillColor(ACCENT)
        c.rect(0, self.h - 10, self.w, 10, stroke=0, fill=1)
        c.setFillColor(INK)
        c.setFont("Times-Bold", 22)
        c.drawString(self.m, self.h - self.m - 14, heading)
        y = self.h - self.m - 30
        if sub:
            c.setFont("Helvetica", 10)
            c.setFillColor(MUTED)
            for line in wrap(sub, "Helvetica", 10, self.w - 2 * self.m):
                c.drawString(self.m, y, line)
                y -= 13
        c.setFont("Helvetica", 8)
        c.setFillColor(MUTED)
        c.drawString(self.m, self.m / 2, self.footer_text)
        c.drawRightString(self.w - self.m, self.m / 2, f"{self.page_no}")
        c.setFillColor(INK)
        return y - 10

    def save(self):
        self.c.save()


def wrap(text, font, size, width):
    from reportlab.pdfbase.pdfmetrics import stringWidth
    words, lines, cur = text.split(), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if stringWidth(t, font, size) <= width:
            cur = t
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def table(d, y, cols, rows, row_h=18, header_fill=SOFT, font_size=9, min_rows=0):
    """cols: [(title, width_fraction)]. Draws header + rows (+ blank rows to min_rows). Returns new y."""
    c, x0, width = d.c, d.m, d.w - 2 * d.m
    xs = [x0]
    for _, f in cols:
        xs.append(xs[-1] + f * width)
    c.setFillColor(header_fill)
    c.rect(x0, y - row_h, width, row_h, stroke=0, fill=1)
    c.setFillColor(INK)
    c.setFont("Helvetica-Bold", font_size)
    for i, (t, _) in enumerate(cols):
        c.drawString(xs[i] + 4, y - row_h + 5, t)
    y -= row_h
    all_rows = list(rows) + [[""] * len(cols)] * max(0, min_rows - len(rows))
    c.setFont("Helvetica", font_size)
    c.setStrokeColor(LINE)
    c.setLineWidth(0.5)
    for r in all_rows:
        if y - row_h < d.m:
            break
        for i, v in enumerate(r):
            c.drawString(xs[i] + 4, y - row_h + 5, str(v))
        y -= row_h
        c.line(x0, y, x0 + width, y)
    for x in xs:
        c.line(x, y, x, y + row_h * (len(all_rows) + 1))
    return y


def timing(t):
    if not t:
        return ""
    f, to = t["from_weeks"], t["to_weeks"]
    s = lambda n: "frost date" if n == 0 else (f"{-n} wk before" if n < 0 else f"{n} wk after")
    if f == to:
        return s(f)
    if f < 0 and to < 0:
        return f"{-to}-{-f} wk before"
    if f > 0 and to > 0:
        return f"{f}-{to} wk after"
    return f"{s(f)} to {s(to)}"


def build_kit(data, paper, out):
    d = Doc(os.path.join(out, f"frost-date-garden-planner.{paper}.pdf"), paper, "Frost Date Garden Planner", "Printable garden season planner")
    y = d.page("Frost Date Garden Planner", "A printable season planner timed from your last spring frost date. Draft for review.")
    c = d.c
    steps = [
        "1. Find your last spring frost date. The free planting calendar estimates it from your ZIP code using NOAA 1991-2020 climate normals and shows the weather station and its distance.",
        "2. Fill in the planting calendar worksheet: write your frost date at the top, then count the weeks back or forward for each crop.",
        "3. Sketch your beds on the grid pages, list your seeds, and log what you sow, transplant and harvest.",
        "4. At the end of the season, write next year's notes while you still remember.",
        "Frost dates are estimates, not guarantees: in half of years the last frost comes later than the 50% date. Watch the forecast before planting out tender crops.",
    ]
    c.setFont("Helvetica", 11)
    for s in steps:
        for line in wrap(s, "Helvetica", 11, d.w - 2 * d.m):
            c.drawString(d.m, y, line)
            y -= 15
        y -= 6
    c.setFont("Helvetica-Bold", 11)
    c.drawString(d.m, y - 10, "My last spring frost date: ______________   First fall frost: ______________")
    c.drawString(d.m, y - 32, "Station / source: ____________________________________________")

    y = d.page("Planting calendar worksheet", "Write your last-frost date, then the dates for each crop. Week offsets are general guidance from the cited sources; check seed packets.")
    rows = [[cr["name"], timing(cr["start_indoors"]), timing(cr["transplant"]), timing(cr["direct_sow"]), ""] for cr in data["crops"]]
    table(d, y, [("Crop", 0.16), ("Start indoors", 0.2), ("Plant out", 0.2), ("Sow outdoors", 0.2), ("My dates", 0.24)], rows, row_h=16.5, font_size=8)

    # Bed grid: 1-foot squares are drawn at a printable scale (the label says so)
    y = d.page("Bed grid", "One square = one foot (or any unit you choose). Sketch beds, paths and what goes where.")
    cell = 0.45 * inch
    cols, rows_n = int((d.w - 2 * d.m) // cell), int((y - d.m - 10) // cell)
    c.setStrokeColor(LINE)
    c.setLineWidth(0.5)
    for i in range(cols + 1):
        c.line(d.m + i * cell, y, d.m + i * cell, y - rows_n * cell)
    for j in range(rows_n + 1):
        c.line(d.m, y - j * cell, d.m + cols * cell, y - j * cell)

    y = d.page("Square-foot spacing", "Plants per square for each crop, copied from your seed packets. A blank table on purpose: spacing varies by variety.")
    table(d, y, [("Crop", 0.25), ("Variety", 0.25), ("Spacing on packet", 0.25), ("Plants per square", 0.25)], [], min_rows=34)

    y = d.page("Seed inventory", "What you have, where it came from and how old it is.")
    table(d, y, [("Crop", 0.18), ("Variety", 0.22), ("Source", 0.18), ("Packed for", 0.12), ("Quantity", 0.12), ("Notes", 0.18)], [], min_rows=34)

    y = d.page("Sowing log", "Every sowing and transplant, indoors and out.")
    table(d, y, [("Date", 0.12), ("Crop / variety", 0.26), ("Indoors / out", 0.14), ("Where", 0.16), ("Up on", 0.12), ("Notes", 0.2)], [], min_rows=34)

    y = d.page("Succession-sowing planner", "For crops you sow more than once. Write the interval, then each planned sowing date.")
    table(d, y, [("Crop", 0.18), ("Every", 0.1), ("1st", 0.12), ("2nd", 0.12), ("3rd", 0.12), ("4th", 0.12), ("5th", 0.12), ("6th", 0.12)], [], min_rows=34)

    y = d.page("Harvest log", "What came in, when and how much.")
    table(d, y, [("Date", 0.14), ("Crop", 0.24), ("Amount", 0.16), ("Quality", 0.16), ("Notes", 0.3)], [], min_rows=34)

    y = d.page("Next year", "What worked, what didn't, what to grow again.")
    c.setStrokeColor(LINE)
    for i in range(int((y - d.m) // 24)):
        c.line(d.m, y - i * 24, d.w - d.m, y - i * 24)

    y = d.page("Sources and credits")
    c.setFont("Helvetica", 10)
    lines = [f"{s['title']}: {s['url']} (accessed {s['accessed']})." for s in data["crop_sources"]] + [
        "Frost dates: NOAA NCEI U.S. Climate Normals 1991-2020, annual/seasonal (CC0). The 50% last-spring 32F date is used by default.",
        "ZIP locations: US Census Bureau 2025 ZCTA Gazetteer internal points (public domain).",
        "This kit gives general planting guidance only. It is not pesticide, legal or professional advice.",
    ]
    for s in lines:
        for line in wrap(s, "Helvetica", 10, d.w - 2 * d.m):
            c.drawString(d.m, y, line)
            y -= 14
        y -= 6
    d.save()
    return d.page_no


def build_personal(data, paper, out):
    s = data["sample"]
    d = Doc(os.path.join(out, f"personal-calendar.sample-{s['zip']}.{paper}.pdf"), paper, f"Personal planting calendar (sample, ZIP {s['zip']})", "Planting calendar for one frost date")
    sub = (f"SAMPLE for ZIP {s['zip']}. Station {s['station']}, {s['km']} km away. Estimated last spring frost {s['last_frost']} "
           f"(half of years have a later frost); first fall frost about {s['first_fall']}. Source: NOAA 1991-2020 climate normals. {s['season']} season.")
    y = d.page("Your planting calendar", sub)
    rows = []
    for m in s["months"]:
        rows.append([m["month"].upper(), "", ""])
        rows += [[r["when"], r["what"], r["crop"]] for r in m["rows"]]
    per_page = int((y - d.m) // 15) - 1
    first = True
    while rows:
        if not first:
            y = d.page("Your planting calendar (continued)", f"SAMPLE for ZIP {s['zip']}.")
            per_page = int((y - d.m) // 15) - 1
        chunk, rows = rows[:per_page], rows[per_page:]
        table(d, y, [("When", 0.3), ("What", 0.35), ("Crop", 0.35)], chunk, row_h=15, font_size=9)
        first = False
    d.save()
    return d.page_no


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    data = json.load(open(a.data))
    os.makedirs(a.out, exist_ok=True)
    for paper in ("letter", "a4"):
        k = build_kit(data, paper, a.out)
        p = build_personal(data, paper, a.out)
        print(f"{paper}: kit {k} pages, personal sample {p} pages")
