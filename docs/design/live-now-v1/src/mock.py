import html
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ICONS = json.load(open(os.path.join(HERE, "icons.json")))

STATE = {
    "starting": ("Starting", "loader-circle"),
    "working": ("Working", None),
    "thinking": ("Thinking", None),
    "quiet": ("Quiet", "clock"),
    "stalled": ("Stalled", "triangle-alert"),
    "pausing": ("Pausing", "loader-circle"),
    "paused": ("Paused", "pause"),
    "resuming": ("Resuming", "loader-circle"),
    "failed": ("Pause failed", "circle-alert"),
}
GROUP_OF = {
    "stalled": "attn", "quiet": "attn", "failed": "attn",
    "starting": "work", "working": "work", "thinking": "work", "pausing": "work", "resuming": "work",
    "paused": "paused",
}
GROUPS = [("attn", "Needs attention", "stalled"), ("work", "Working", "working"), ("paused", "Paused", "paused")]


def ic(name, cls="i"):
    return '<svg class="%s" viewBox="0 0 24 24" aria-hidden="true">%s</svg>' % (cls, ICONS[name])


def esc(text):
    return html.escape(text, quote=False)


def chip(state, extra=""):
    label, icon = STATE[state]
    inner = ic(icon) if icon else '<span class="d"></span>'
    text = label + (" " + extra if extra else "")
    return '<span class="chip st-%s">%s%s</span>' % (state, inner, esc(text))


def av(item, size="", state=None, hue=None):
    st = state or item["state"]
    gray = " gray" if st == "paused" else ""
    cls = "av" + (" " + size if size else "") + gray + " st-" + st
    return '<span class="%s" style="--h:%d"><i></i></span>' % (cls, hue if hue is not None else item["hue"])


def who(item, size=""):
    extra = item.get("also")
    if not extra:
        return av(item, size)
    return '<span class="avs">%s%s</span>' % (av(item, "s20"), av(item, "s20", hue=extra["hue"]))


def btn(label, icon=None, kind="", title=None):
    cls = "btn" + (" " + kind if kind else "")
    if label is None:
        return '<span class="%s icon" title="%s">%s</span>' % (cls, esc(title or ""), ic(icon))
    return '<span class="%s">%s%s</span>' % (cls, ic(icon) if icon else "", esc(label))


def primary(item, icon_only=False):
    s = item["state"]
    table = {
        "paused": ("Resume", "play", "pri"),
        "pausing": ("Pausing", "loader-circle", "dis"),
        "resuming": ("Resuming", "loader-circle", "dis"),
        "failed": ("Retry pause", "rotate-ccw", ""),
    }
    label, icon, kind = table.get(s, ("Pause", "pause", ""))
    if icon_only:
        return btn(None, icon, kind, label)
    return btn(label, icon, kind)


def path_text(path):
    if not path:
        return ""
    shown = path[-2:]
    lead = "\u2026 \u203a " if len(path) > 2 else ""
    return lead + " \u203a ".join(shown)


def todo_line(item):
    t = item.get("todo")
    if not t:
        return ""
    done, total, text = t
    pct = int(100 * done / total)
    return '<div class="row todo"><span class="bar"><b style="width:%d%%"></b></span><span>%d/%d</span><span class="ell">%s</span></div>' % (pct, done, total, esc(text))


def act_line(item):
    icon, text = item["act"]
    return '<div class="row"><span class="t3">%s</span><span class="ell">%s</span></div>' % (ic(icon), esc(text))


def row(item, sel=False):
    p = path_text(item["path"])
    runs = item.get("also")
    names = esc(item["agent"]) + (" + " + esc(runs["agent"]) if runs else "")
    l2 = '<span class="mono">%s</span><span class="sep">\u00b7</span><span class="ell">%s</span>' % (item["id"], names)
    if runs:
        l2 += '<span class="sep">\u00b7</span><span style="flex:none">2 runs</span>'
    if p:
        l2 += '<span class="sep">\u00b7</span><span class="ell mono">in %s</span>' % esc(p)
    cls = "r" + (" paused" if item["state"] == "paused" else "") + (" sel" if sel else "")
    return (
        '<div class="%s" data-m="row">' % cls
        + who(item)
        + '<div style="min-width:0"><div class="l1 ell">%s</div><div class="l2">%s</div></div>' % (esc(item["title"]), l2)
        + '<div class="act">%s%s</div>' % (act_line(item), todo_line(item))
        + '<div class="stc">%s<span class="dur">%s</span></div>' % (chip(item["state"], item.get("chipx", "")), esc(item.get("dur", "")))
        + '<div class="acts">%s%s%s%s</div>' % (primary(item), btn(None, "message-square", "", "Steer"), btn(None, "arrow-up-right", "", "Open"), btn(None, "ellipsis", "ghost", "More"))
        + "</div>"
    )


def row_compact(item):
    icon, text = item["act"]
    cls = "rc" + (" paused" if item["state"] == "paused" else "")
    return (
        '<div class="%s" data-m="rowc">' % cls
        + av(item, "s20")
        + '<span class="mono t3">%s</span>' % item["id"]
        + '<div class="row" style="min-width:0"><span class="tt ell">%s</span><span class="t3 ell" style="font-size:12px;flex:none;max-width:150px">%s</span></div>' % (esc(item["title"]), esc(item["agent"]))
        + '<div class="row t2" style="font-size:12px;min-width:0"><span class="t3">%s</span><span class="ell">%s</span></div>' % (ic(icon), esc(text))
        + '<div class="row" style="gap:6px">%s</div>' % chip(item["state"], item.get("chipx", ""))
        + '<div class="acts">%s%s</div>' % (primary(item, True), btn(None, "ellipsis", "ghost", "More"))
        + "</div>"
    )


def counts(items):
    c = {"attn": 0, "work": 0, "paused": 0}
    for it in items:
        c[GROUP_OF[it["state"]]] += 1
    return c


def head(items, collapsed=False, density="comfortable", phone=False, filt="all", hidden=0, strip=False):
    c = counts(items)
    chev = ic("chevron-right" if collapsed else "chevron-down")
    out = '<div class="lnh"><span class="t3">%s</span><span class="ldot"></span><span class="ttl">Live now</span><span class="cnt">%d</span>' % (chev, len(items))
    if strip and not phone:
        out += '<span class="avs" style="margin-left:4px">%s</span>' % "".join(av(it, "s20") for it in items[:5])
    if phone:
        bits = []
        if c["attn"]:
            bits.append('<span class="mk st-stalled"><span class="d"></span>%d need attention</span>' % c["attn"])
        if c["paused"]:
            bits.append('<span class="mk st-paused"><span class="d"></span>%d paused</span>' % c["paused"])
        out += '<span style="margin-left:auto;display:flex;gap:10px">%s</span></div>' % "".join(bits)
        return out
    out += '<span style="flex:1"></span>'
    chips = [("all", "All", None, len(items))]
    for key, label, st in GROUPS:
        chips.append((key, label, st, c[key]))
    for key, label, st, n in chips:
        if key != "all" and n == 0:
            continue
        dot = '<span class="d st-%s"></span>' % st if st else ""
        out += '<span class="fchip%s">%s%s <span style="font-weight:500;opacity:.8">%d</span></span>' % (" on" if key == filt else "", dot, label, n)
    if hidden:
        out += '<span class="fchip">%s%d hidden by filters</span>' % (ic("eye-off"), hidden)
    seg = '<span class="seg"><span class="%s">%sComfortable</span><span class="%s">%sCompact</span></span>' % (
        "on" if density == "comfortable" else "", ic("rows-2"), "on" if density == "compact" else "", ic("rows-3"))
    out += seg + "</div>"
    return out


def grouped(items, render, limit=None, more=None):
    out = []
    shown = 0
    for key, label, st in GROUPS:
        members = [it for it in items if GROUP_OF[it["state"]] == key]
        if not members:
            continue
        out.append('<div class="grp st-%s"><span class="d"></span>%s<span style="font-weight:500">%d</span></div>' % (st, label, len(members)))
        visible = members if (limit is None or key != "work") else members[:limit]
        for it in visible:
            out.append(render(it))
        shown += len(visible)
        hidden = len(members) - len(visible)
        if hidden and more:
            out.append(more(hidden))
    return "".join(out), shown


def section_desktop(items, density="comfortable", limit=None, filt="all", hidden=0, sel=None, collapsed=False):
    h = head(items, collapsed=collapsed, density=density, filt=filt, hidden=hidden, strip=collapsed)
    if collapsed:
        return '<div data-m="ln-desktop-collapsed">%s</div>' % h
    if density == "compact":
        render = row_compact
    else:
        def render(it):
            return row(it, sel == it["id"])
    body, shown = grouped(items, render, limit=limit, more=lambda n: '<div class="more" style="padding:8px 12px 8px 58px;border-top:1px solid var(--line-soft)">Show %d more working</div>' % n)
    return '<div data-m="ln-desktop-%s">%s<div class="lst" style="margin-top:6px">%s</div></div>' % (density, h, body)


def phone_card(item):
    p = path_text(item["path"])
    meta = item["id"] + " \u00b7 " + item["agent"] + (" \u00b7 in " + p if p else "")
    cls = "pc" + (" paused" if item["state"] == "paused" else "")
    icon, text = item["act"]
    return (
        '<div class="%s" data-m="pcard">' % cls
        + '<div class="h">%s<div style="min-width:0"><div class="tt">%s</div><div class="meta ell">%s</div></div></div>' % (av(item, "s36"), esc(item["title"]), esc(meta))
        + '<div class="stl">%s<span class="dur">%s</span><span class="t3">%s</span><span class="ell">%s</span></div>' % (chip(item["state"], item.get("chipx", "")), esc(item.get("dur", "")), ic(icon), esc(text))
        + ('<div style="margin-top:8px">%s</div>' % todo_line(item) if item.get("todo") else "")
        + '<div class="acts">%s%s%s%s</div>' % (primary(item), btn(None, "message-square", "", "Steer"), btn(None, "arrow-up-right", "", "Open"), btn(None, "ellipsis", "", "More"))
        + "</div>"
    )


def phone_compact(item):
    icon, text = item["act"]
    cls = "pcc" + (" paused" if item["state"] == "paused" else "")
    return (
        '<div class="%s" data-m="pcompact">' % cls
        + av(item)
        + '<div style="min-width:0"><div class="tt ell">%s</div><div class="sub">%s<span class="dur">%s</span><span class="ell">%s</span></div></div>' % (esc(item["title"]), chip(item["state"], item.get("chipx", "")), esc(item.get("dur", "")), esc(text))
        + primary(item, True)
        + "</div>"
    )


def section_phone(items, density="compact", limit=None, collapsed=False):
    h = head(items, collapsed=collapsed, phone=True, strip=collapsed)
    if collapsed:
        return '<div data-m="ln-phone-collapsed">%s</div>' % h
    more = lambda n: '<div class="btn ghost" style="width:100%%;border-radius:0;border-top:1px solid var(--line-soft)">Show %d more working</div>' % n
    if density == "compact":
        body, shown = grouped(items, phone_compact, limit=limit, more=more)
        inner = '<div class="lst" style="margin-top:4px">%s</div>' % body
    else:
        body, shown = grouped(items, phone_card, limit=limit, more=more)
        inner = '<div style="margin-top:2px">%s</div>' % body
    return '<div data-m="ln-phone-%s">%s%s</div>' % (density, h, inner)


def phone(inner, theme="light", height=844, overlay="", kanban=False, title="TASKS"):
    seg = '<span class="seg" style="flex:none"><span class="%s" style="height:38px">%s</span><span class="%s" style="height:38px">%s</span></span>' % (
        "" if kanban else "on", ic("list"), "on" if kanban else "", ic("square-kanban"))
    return (
        '<div class="ui touch %s"><div class="phone" style="height:%dpx">' % (theme, height)
        + '<div class="sb"><span>06.26</span><span class="isl"></span><span style="font-size:13px">5G</span></div>'
        + '<div class="apph"><span class="t2">%s</span>%s</div>' % (ic("menu"), title)
        + '<div class="tools"><div class="srch">%s<span class="ell">Search title, ID, description</span></div>%s<span class="tb">%s</span></div>' % (ic("search"), seg, ic("funnel"))
        + '<div class="pbody2">%s</div>' % inner
        + '<div class="nav"><span>%sHome</span><span>%sInbox</span><span class="on">%sTasks</span><span>%sChat</span><span>%sMore</span></div>' % (ic("house"), ic("inbox"), ic("circle-check"), ic("message-circle"), ic("menu"))
        + overlay
        + "</div></div>"
    )


def desk(inner, theme="light", width=1240, kanban=False, tail=True):
    seg = '<span class="seg"><span class="%s">%sList</span><span class="%s">%sBoard</span></span>' % ("" if kanban else "on", ic("list"), "on" if kanban else "", ic("square-kanban"))
    rest = ""
    if tail and not kanban:
        rows = ["Backlog item 20: follow-up from weekly review", "Backlog item 19: follow-up from weekly review", "Backlog item 18: follow-up from weekly review"]
        rest = '<div class="list2">%s</div>' % "".join('<div><span class="t3">%s</span>%s</div>' % (ic("circle-check"), r) for r in rows)
    return (
        '<div class="ui %s" style="width:%dpx"><div class="desk">' % (theme, width)
        + '<div class="dh">TASKS</div>'
        + '<div class="dtools"><span class="btn">%sNew Task</span><div class="srch">%s<span class="ell">Search title, ID, description</span></div><span style="flex:1"></span>%s<span class="tb">%s</span><span class="tb">%s</span></div>' % (ic("plus"), ic("search"), seg, ic("funnel"), ic("arrow-up-down"))
        + '<div class="dbody">%s%s</div>' % (inner, rest)
        + "</div></div>"
    )


def kcard(item):
    icon, text = item["act"]
    cls = "kc" + (" paused" if item["state"] == "paused" else "")
    return (
        '<div class="%s" data-m="kcard">' % cls
        + '<div class="top"><span class="mono">%s</span><span style="flex:1"></span>%s</div>' % (item["id"], chip(item["state"], item.get("chipx", "")))
        + '<div class="tt">%s</div>' % esc(item["title"])
        + '<div class="act row"><span class="t3">%s</span><span class="ell">%s</span></div>' % (ic(icon), esc(text))
        + '<div class="bot">%s<span class="ell t2" style="font-size:12px;flex:1">%s</span><span class="dur">%s</span>%s</div>' % (av(item, "s20"), esc(item["agent"]), esc(item.get("dur", "")), primary(item, True))
        + "</div>"
    )


def band(items, per_lane=2, phone_mode=False, collapsed=False):
    h = head(items, collapsed=collapsed, phone=phone_mode, strip=collapsed)
    if collapsed:
        return '<div class="band" data-m="band-collapsed">%s</div>' % h
    lanes = []
    for key, label, st in GROUPS:
        members = [it for it in items if GROUP_OF[it["state"]] == key]
        cards = "".join(kcard(it) for it in members[:per_lane])
        if not members:
            cards = '<div class="t3" style="font-size:12px;padding:6px 4px">Nothing here</div>'
        more = '<div class="more">+%d more</div>' % (len(members) - per_lane) if len(members) > per_lane else ""
        lanes.append('<div class="lane"><div class="lh st-%s"><span class="d"></span>%s<span class="c">%d</span></div>%s%s</div>' % (st, label, len(members), cards, more))
    if phone_mode:
        lanes_html = '<div style="display:grid;grid-auto-flow:column;grid-auto-columns:262px;gap:10px;margin-top:6px;overflow:hidden;margin-right:-10px">%s</div>' % "".join(lanes)
    else:
        lanes_html = '<div class="lanes">%s</div>' % "".join(lanes)
    return '<div class="band" data-m="band">%s%s</div>' % (h, lanes_html)


def scard(ident, title, agent=None, hue=200, marker=None):
    mk = ""
    if marker:
        st, label = marker
        mk = '<span class="mk st-%s"><span class="d"></span>%s</span>' % (st, label)
    w = ""
    if agent:
        w = '<div class="who"><span class="av s20 st-working" style="--h:%d"></span>%s</div>' % (hue, esc(agent))
    return '<div class="sc"><div class="id">%s%s</div><div class="tt">%s</div>%s</div>' % (ident, mk, esc(title), w)


def column(name, color, cards, count):
    return '<div class="col"><div class="ch"><span style="color:%s">%s</span><span>%s</span><span class="c">%d</span></div>%s</div>' % (color, ic("circle-check"), name, count, "".join(cards))


def state_diagram():
    boxes = {
        "queued": (20, 130, "Queued", "run waits for a slot"),
        "running": (270, 130, "Running", "Starting, Working, Thinking, Quiet, Stalled"),
        "pausing": (540, 30, "Pausing", "hold active, run stops at a safe point"),
        "paused": (810, 30, "Paused", "hold active, no run, 0 tokens"),
        "resuming": (810, 230, "Resuming", "hold released, wake queued"),
        "failed": (540, 230, "Pause failed", "stop not confirmed in time"),
        "stopped": (270, 330, "Cancelled", "Stop: leaves Live now"),
        "ended": (1060, 130, "Not live", "pause ended without a wake"),
    }
    w, h = 210, 58
    fills = {"paused": "#eceef4", "pausing": "#f2f3f7", "failed": "#fdeceb", "running": "#e6f0fb", "resuming": "#e6f0fb", "stopped": "#f5f5f6", "ended": "#f5f5f6", "queued": "#f5f5f6"}
    parts = ['<svg viewBox="0 0 1290 420" style="width:100%;height:auto;font-family:InterVariable,sans-serif">',
             '<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#3f4556"/></marker></defs>']
    for key, (x, y, label, sub) in boxes.items():
        parts.append('<rect x="%d" y="%d" width="%d" height="%d" rx="10" fill="%s" stroke="#8d94a7"/>' % (x, y, w, h, fills[key]))
        parts.append('<text x="%d" y="%d" font-size="15" font-weight="650" fill="#1d2029">%s</text>' % (x + 12, y + 23, label))
        parts.append('<text x="%d" y="%d" font-size="10.5" fill="#3f4556">%s</text>' % (x + 12, y + 43, sub))

    def arrow(pts, label, lx, ly):
        d = "M" + " L".join("%d %d" % p for p in pts)
        parts.append('<path d="%s" stroke="#3f4556" stroke-width="1.6" fill="none" marker-end="url(#ah)"/>' % d)
        if label:
            parts.append('<text x="%d" y="%d" font-size="11" font-weight="600" fill="#1d2029">%s</text>' % (lx, ly, label))

    arrow([(230, 159), (268, 159)], "", 0, 0)
    arrow([(480, 145), (538, 70)], "Pause", 488, 98)
    arrow([(750, 59), (808, 59)], "safe point", 752, 50)
    arrow([(915, 88), (915, 228)], "Resume", 923, 165)
    arrow([(810, 275), (790, 310), (455, 310), (455, 190)], "run claimed", 600, 304)
    arrow([(680, 88), (680, 228)], "error or 120 s", 688, 165)
    arrow([(600, 230), (600, 90)], "Retry", 552, 165)
    arrow([(1020, 59), (1165, 59), (1165, 128)], "End pause", 1060, 50)
    arrow([(375, 188), (375, 328)], "Stop", 383, 265)
    parts.append('<text x="20" y="410" font-size="11" fill="#3f4556">Restart or upgrade: Paused stays Paused (hold row, no process). A run still Pausing at restart is interrupted by the shutdown drain and the hold gate keeps it from re-claiming, so it lands in Paused.</text>')
    parts.append("</svg>")
    return "".join(parts)
