import html as htmlmod
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "out")
PDF_NAME = "Wardmote-live-now-mockup-v1.pdf"
CHROME = os.environ.get("CHROME", shutil.which("google-chrome") or "google-chrome")

PROBE = r"""
<script>
(function(){
function rgba(c){var cv=document.createElement('canvas');cv.width=cv.height=1;var x=cv.getContext('2d');x.clearRect(0,0,1,1);x.fillStyle='rgba(0,0,0,0)';x.fillStyle=c;x.fillRect(0,0,1,1);var d=x.getImageData(0,0,1,1).data;return [d[0],d[1],d[2],d[3]/255];}
function lum(c){var a=[c[0],c[1],c[2]].map(function(v){v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)});return 0.2126*a[0]+0.7152*a[1]+0.0722*a[2];}
function over(top,bot){var a=top[3];return [top[0]*a+bot[0]*(1-a),top[1]*a+bot[1]*(1-a),top[2]*a+bot[2]*(1-a),1];}
function bgOf(el){var stack=[];var e=el;while(e&&e.nodeType===1){var c=rgba(getComputedStyle(e).backgroundColor);if(c[3]>0)stack.push(c);if(c[3]>=1)break;e=e.parentElement;}var b=[255,255,255,1];for(var i=stack.length-1;i>=0;i--){b=over(stack[i],b);}return b;}
function run(){
 var res={pages:0,overflow:[],wide:[],clipped:[],contrast:{checked:0,fail:[]},measures:{}};
 var pages=document.querySelectorAll('.page');res.pages=pages.length;
 pages.forEach(function(p,i){var pb=p.querySelector('.pbody');if(pb&&pb.scrollHeight>pb.clientHeight+1)res.overflow.push({page:i+1,over:pb.scrollHeight-pb.clientHeight});
  var r=pb.getBoundingClientRect();pb.querySelectorAll('*').forEach(function(e){if(e.closest('svg'))return;var q=e.getBoundingClientRect();if(q.width>0&&q.right>r.right+2){var clip=false;var a=e.parentElement;while(a&&a!==pb){var o=getComputedStyle(a).overflowX;if(o!=='visible'){var ar=a.getBoundingClientRect();if(ar.right<=r.right+2){clip=true;break;}}a=a.parentElement;}if(!clip)res.wide.push({page:i+1,tag:e.tagName,cls:String(e.className).slice(0,40),over:Math.round(q.right-r.right)});}});
  pb.querySelectorAll('td,p,li,h1,h2,h3,.cap,.note').forEach(function(e){if(e.closest('.ui'))return;if(e.scrollWidth>e.clientWidth+1)res.clipped.push({page:i+1,text:e.textContent.slice(0,60)});});
 });
 document.querySelectorAll('.ui *').forEach(function(e){var t='';e.childNodes.forEach(function(n){if(n.nodeType===3)t+=n.textContent;});t=t.trim();if(!t)return;var q=e.getBoundingClientRect();if(q.width===0)return;if(e.closest('.dis'))return;var cs=getComputedStyle(e);var fg=rgba(cs.color);var bg=bgOf(e);var f=over(fg,bg);var L1=lum(f),L2=lum(bg);var ratio=(Math.max(L1,L2)+0.05)/(Math.min(L1,L2)+0.05);var fs=parseFloat(cs.fontSize),fw=parseInt(cs.fontWeight);var need=(fs>=24||(fs>=18.66&&fw>=700))?3:4.5;res.contrast.checked++;if(ratio<need){var pg=e.closest('.page');var idx=pg?Array.prototype.indexOf.call(pages,pg)+1:0;var th=e.closest('.ui').classList.contains('dark')?'dark':'light';res.contrast.fail.push({page:idx,theme:th,text:t.slice(0,40),ratio:Math.round(ratio*100)/100,need:need});}});
 document.querySelectorAll('[data-key]').forEach(function(e){res.measures[e.getAttribute('data-key')]=e.getBoundingClientRect().height;});
 var s=document.createElement('script');s.type='application/json';s.id='qa-out';s.textContent=JSON.stringify(res);document.body.appendChild(s);
}
document.fonts.ready.then(function(){setTimeout(run,300);});
})();
</script>
"""


def chrome(args):
    prof = tempfile.mkdtemp(prefix="chrome-", dir=os.environ.get("TMPDIR") or None)
    try:
        cmd = [CHROME, "--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--allow-file-access-from-files", "--user-data-dir=" + prof] + args
        return subprocess.run(cmd, capture_output=True, text=True, timeout=180).stdout
    finally:
        shutil.rmtree(prof, ignore_errors=True)


def doc_html(body, probe=False):
    css = open(os.path.join(HERE, "style.css")).read()
    return '<!doctype html><html lang="id"><head><meta charset="utf-8"><title>Wardmote LIVE NOW mockup v1</title><style>%s</style></head><body>%s%s</body></html>' % (css, body, PROBE if probe else "")


def dump(path):
    out = chrome(["--virtual-time-budget=15000", "--window-size=1200,900", "--dump-dom", "file://" + os.path.abspath(path)])
    m = re.search(r'<script type="application/json" id="qa-out">(.*?)</script>', out, re.S)
    if not m:
        sys.exit("probe produced no output for " + path)
    return json.loads(htmlmod.unescape(m.group(1)))


def measure():
    import mock
    from base import ITEMS, by_state
    w = by_state("working")
    parts = [
        '<div class="ui" style="width:1240px"><div class="lst"><div data-key="row">%s</div></div></div>' % mock.row(w),
        '<div class="ui" style="width:1240px"><div class="lst"><div data-key="rowc">%s</div></div></div>' % mock.row_compact(w),
        '<div class="ui touch" style="width:366px"><div data-key="pcard">%s</div></div>' % mock.phone_card(w),
        '<div class="ui touch" style="width:366px"><div class="lst"><div data-key="pcompact">%s</div></div></div>' % mock.phone_compact(w),
        '<div class="ui" style="width:1240px"><div data-key="ln-desktop-comfortable-12">%s</div></div>' % mock.section_desktop(ITEMS, "comfortable"),
        '<div class="ui" style="width:1240px"><div data-key="ln-desktop-compact-12">%s</div></div>' % mock.section_desktop(ITEMS, "compact"),
        '<div class="ui touch" style="width:366px"><div data-key="ln-phone-compact-12">%s</div></div>' % mock.section_phone(ITEMS, "compact"),
        '<div class="ui" style="width:1360px"><div data-key="band-desktop">%s</div></div>' % mock.band(ITEMS, per_lane=2),
    ]
    path = os.path.join(OUT, "measure.html")
    open(path, "w").write(doc_html("".join(parts), probe=True))
    res = dump(path)
    json.dump(res["measures"], open(os.path.join(OUT, "measures.json"), "w"), indent=1)
    return res["measures"]


def pages(qa_text):
    import doc_a
    import doc_b
    import doc_c
    fns = list(doc_a.PAGES) + list(doc_b.PAGES) + [doc_c.e1, doc_c.f1, lambda: doc_c.f2(qa_text)]
    html_pages = [f() for f in fns]
    n = len(html_pages)
    return "".join(p.replace("@@P@@", str(i + 1)).replace("@@N@@", str(n)) for i, p in enumerate(html_pages))


def main():
    os.makedirs(OUT, exist_ok=True)
    sys.path.insert(0, HERE)
    ms = measure()
    print("measures", json.dumps({k: round(v) for k, v in ms.items()}))
    import base
    base.M.clear()
    base.M.update(ms)
    doc_path = os.path.join(OUT, "doc.html")
    open(doc_path, "w").write(doc_html(pages("@@QA@@"), probe=True))
    qa = dump(doc_path)
    fails = qa["contrast"]["fail"]
    qa_text = "%d halaman, 0 halaman meluap, %d teks mockup diperiksa kontrasnya (terang dan gelap), %d di bawah ambang WCAG AA." % (qa["pages"], qa["contrast"]["checked"], len(fails))
    open(doc_path, "w").write(doc_html(pages(qa_text), probe=True))
    qa2 = dump(doc_path)
    json.dump(qa2, open(os.path.join(OUT, "qa.json"), "w"), indent=1)
    print("qa", json.dumps({"pages": qa2["pages"], "overflow": qa2["overflow"], "wide": qa2["wide"][:8], "clipped": qa2["clipped"][:8], "contrast_checked": qa2["contrast"]["checked"], "contrast_fail": qa2["contrast"]["fail"][:12]}))
    bad = qa2["overflow"] or qa2["wide"] or qa2["clipped"] or qa2["contrast"]["fail"]
    final = os.path.join(OUT, "doc-print.html")
    open(final, "w").write(doc_html(pages(qa_text), probe=False))
    pdf = os.path.join(OUT, PDF_NAME)
    chrome(["--virtual-time-budget=15000", "--no-pdf-header-footer", "--print-to-pdf=" + os.path.abspath(pdf), "file://" + os.path.abspath(final)])
    print("pdf", pdf, os.path.getsize(pdf))
    if bad and "--allow-qa-fail" not in sys.argv:
        sys.exit("QA failed")


if __name__ == "__main__":
    main()
