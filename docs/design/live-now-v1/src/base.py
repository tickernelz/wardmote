import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
MEASURES_PATH = os.path.join(HERE, "..", "out", "measures.json")
BASE_SHA = "7e9514f7b6"
VERSION = "2026.1114.3"
DATE = "15 November 2026"


def measures():
    if os.path.exists(MEASURES_PATH):
        return json.load(open(MEASURES_PATH))
    return {}


M = measures()


def m(key):
    v = M.get(key)
    if v is None:
        return "?"
    return "%d" % round(v)


def page(body, kicker="", title="", cls=""):
    head = ""
    if kicker or title:
        head = '<div><div class="kick">%s</div><h2>%s</h2></div>' % (kicker, title)
    return '<section class="page %s"><div class="pbody">%s%s</div><div class="foot"><span>Wardmote LIVE NOW \u00b7 mockup v1 \u00b7 %s \u00b7 basis %s</span><span>hal. @@P@@ / @@N@@</span></div></section>' % (cls, head, body, DATE, BASE_SHA)


def z(html, scale, width=None):
    w = "width:%dpx;" % width if width else ""
    return '<div style="zoom:%s;%s">%s</div>' % (scale, w, html)


def img(name, style=""):
    return '<img class="shot" src="../assets/%s" style="%s">' % (name, style)


def cap(text):
    return '<div class="cap">%s</div>' % text


def note(text, kind=""):
    return '<div class="note %s">%s</div>' % (kind, text)


def table(headers, rows, widths=None, rec_rows=()):
    cols = ""
    if widths:
        cols = "<colgroup>%s</colgroup>" % "".join('<col style="width:%s">' % w for w in widths)
    th = "".join("<th>%s</th>" % h for h in headers)
    trs = []
    for i, r in enumerate(rows):
        cls = ' class="rec"' if i in rec_rows else ""
        trs.append("<tr%s>%s</tr>" % (cls, "".join("<td>%s</td>" % c for c in r)))
    return '<table class="t">%s<thead><tr>%s</tr></thead><tbody>%s</tbody></table>' % (cols, th, "".join(trs))


def it(agent, hue, ident, title, path, state, dur, act, todo=None, chipx="", also=None):
    return {"agent": agent, "hue": hue, "id": ident, "title": title, "path": path, "state": state, "dur": dur, "act": act, "todo": todo, "chipx": chipx, "also": also}


ITEMS = [
    it("Hendra (Reviewer)", 150, "ZHA-6240", "Review PR #431: kanban live band", ["ZHA-6238"], "stalled", "41m 12s", ("triangle-alert", "No output for 19 min, last tool fabric_exec"), (2, 5, "Read diff, run focused tests"), "19m"),
    it("Bayu (Odoo Dev)", 60, "ZHA-5388", "DCM SO Sparepart: konfigurasi + perbaikan data (SP-KONF-1/2/3)", ["ZHA-5324", "ZHA-5380"], "quiet", "22m 03s", ("scroll-text", "Running bash: pytest -q addons/dms_so"), (3, 8, "Backfill SO lines on erptest"), "4m"),
    it("Dimas (Infra)", 220, "ZHA-6228", "Lab0 backup S3 rotation proof", ["ZHA-6201"], "failed", "8m 40s", ("circle-alert", "Run did not stop within 120 s"), None),
    it("Yoga (Apollo Runtime Dev)", 30, "ZHA-6241", "main red: test_reader_is_unsafe_while_every_reader_is_parked", ["ZHA-5324", "ZHA-6148", "ZHA-6237"], "working", "9m 56s", ("clock", "Running wait"), (0, 10, "Read test, reader source, commit fix")),
    it("Raka (OSS Dev)", 330, "ZHA-6242", "Wardmote LIVE NOW: rombak total UI/UX, pause dan resume, kanban", ["ZHA-4722"], "thinking", "14m 02s", ("message-square", "Comparing the kanban band with a swimlane"), (6, 10, "Render PDF, verify pages")),
    it("Irfan (DCM Dev)", 95, "ZHA-5932", "DCM Helpdesk: ganti service account Google Drive di erptest", ["ZHA-5900"], "pausing", "31m 20s", ("loader-circle", "Stops after the current step: bash"), (4, 6, "Rotate key, verify upload")),
    it("Gita (HMX Dev)", 280, "ZHA-4581", "HMX hmx-002: Fundamental-New upgrade lane", [], "starting", "12s", ("loader-circle", "Preparing workspace")),
    it("Wira (Assistant)", 190, "ZHA-6239", "Kirim ringkasan rapat DCM ke grup", ["ZHA-4722"], "resuming", "paused 6m", ("play", "Resumed by Zhafron, waiting for a slot")),
    it("Sari (QA)", 0, "ZHA-6230", "Regenerate MCP tool schemas after route rename", ["ZHA-6201"], "working", "6m 31s", ("scroll-text", "Running bash: pnpm generate:mcp"), (1, 4, "Diff api-tools.json")),
    it("Nadia (Docs)", 250, "ZHA-6225", "Draft release notes for 2026.1115", [], "working", "2m 02s", ("scroll-text", "Editing CHANGELOG.md")),
    it("Laras (Researcher)", 170, "ZHA-6161", "Local Browser: refs.prune() pada snapshot bercursor", ["ZHA-6100"], "paused", "12m by Zhafron", ("pause", "Last: reading chromium snapshot.ts"), (2, 7, "Compare Chromium and Firefox refs"), "12m"),
    it("Tono (Data)", 120, "ZHA-6219", "Backfill HMSI delivery receipts", ["ZHA-6150"], "paused", "2h 05m by Raka", ("pause", "Last: replaying receipts 1,200 to 1,800"), None, "2h"),
]

MULTI = it("Raka (OSS Dev)", 330, "ZHA-6236", "Wardmote kanban: live marker on status cards", ["ZHA-6201"], "working", "18m 40s", ("scroll-text", "Running bash: vitest KanbanBoard"), (5, 9, "Fix marker contrast"), "", {"agent": "Hendra (Reviewer)", "hue": 150})

STATES = ["starting", "working", "thinking", "quiet", "stalled", "pausing", "paused", "resuming", "failed"]


def by_state(state):
    for x in ITEMS:
        if x["state"] == state:
            return x
    raise KeyError(state)
