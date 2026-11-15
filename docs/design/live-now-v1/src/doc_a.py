from base import ITEMS, MULTI, STATES, BASE_SHA, VERSION, DATE, by_state, cap, img, m, note, page, table, z
import mock


def cover():
    phone_items = [ITEMS[i] for i in (0, 1, 2, 3, 4, 5, 10, 11)]
    ph = mock.phone(mock.section_phone(phone_items, "compact"), "dark", 844)
    body = (
        '<div class="split" style="height:100%;align-items:center;gap:12mm">'
        + '<div class="fill">'
        + '<div class="kick">ZHA-6242 \u00b7 desain saja, belum kode</div>'
        + '<h1 style="font-size:27pt;margin-top:3mm">LIVE NOW dirombak:<br>daftar ringkas, pita kanban,<br>Pause dan Resume per task</h1>'
        + '<p class="lead" style="color:#d9dbe4;margin-top:5mm;max-width:150mm">Mockup detail untuk permintaan Zhafron 15 Nov 2026 06.30 WIB. Narasi bahasa Indonesia, label UI bahasa Inggris. Terang dan gelap, ponsel 390 px dan desktop 1240 px.</p>'
        + '<table class="t" style="margin-top:7mm;max-width:150mm;color:#e6e7ee"><tbody>'
        + '<tr><td style="border-color:#2b2d38">Basis kode</td><td style="border-color:#2b2d38"><code>origin/main %s</code> = Wardmote %s yang terpasang</td></tr>' % (BASE_SHA, VERSION)
        + '<tr><td style="border-color:#2b2d38">Bukti "Sebelum"</td><td style="border-color:#2b2d38">2 tangkapan layar ponsel Zhafron + 6 tangkapan instance uji (1, 3, 12 run)</td></tr>'
        + '<tr><td style="border-color:#2b2d38">Status</td><td style="border-color:#2b2d38">Draf v1 untuk keputusan. Tidak ada kode produk yang berubah.</td></tr>'
        + '<tr><td style="border-color:#2b2d38">Isi</td><td style="border-color:#2b2d38">A Sebelum \u00b7 B Daftar baru \u00b7 C Kanban \u00b7 D Pause dan Resume \u00b7 E Interaksi \u00b7 F Rencana dan keputusan</td></tr>'
        + "</tbody></table>"
        + "</div>"
        + '<div style="flex:none">%s<div class="cap" style="color:#b4b8c6;text-align:center">Ponsel, gelap, kerapatan padat</div></div>' % z(ph, 0.6)
        + "</div>"
    )
    return page(body, cls="cover")


def summary():
    asks = table(
        ["Permintaan Zhafron", "Jawaban di dokumen ini", "Hal."],
        [
            ["1. Rombak total UI/UX LIVE NOW", "Kartu 254 px diganti baris 2 tingkat %s px (nyaman) atau %s px (padat), dikelompokkan Needs attention, Working, Paused" % (m("row"), m("rowc")), "B"],
            ["2. Tombol Pause dan Resume; yang di-pause tetap tampil", "Pause per task memakai hold task yang sudah ada di server ditambah berhenti di titik aman; task Paused tetap di LIVE NOW di grup Paused", "B, D"],
            ["3. LIVE NOW di tampilan kanban, berbentuk kanban", "Pita LIVE NOW di atas papan dengan 3 lajur keadaan (Needs attention, Working, Paused); dibandingkan dengan swimlane", "C"],
            ["4. PDF mockup dulu, kode menunggu persetujuan", "Dokumen ini; 9 keputusan bernomor di halaman terakhir", "F"],
        ],
        ["33%", "60%", "7%"],
    )
    rec = (
        '<ul class="b sm">'
        + "<li><b>Daftar:</b> baris yang bisa dipindai, bukan kartu. 12 task live: %s px nyaman atau %s px padat, sekarang 1142 px (diukur).</li>" % (m("ln-desktop-comfortable-12"), m("ln-desktop-compact-12"))
        + "<li><b>Urutan:</b> yang butuh perhatian (Stalled, Quiet, Pause failed) selalu di atas dan tidak pernah disembunyikan.</li>"
        + "<li><b>Pause:</b> memakai <code>tree hold</code> yang sudah dipakai tombol Pause work di detail task. Task tidak lagi hilang dari LIVE NOW; sesi agen disimpan; biaya token saat Paused nol karena tidak ada proses.</li>"
        + "<li><b>Titik aman:</b> run berhenti setelah tool yang sedang jalan selesai, batas 120 s, lalu Stop now. Alasannya: sesi omp hanya ditandai utuh bila tidak ada tool yang sedang jalan (execute.ts:1257).</li>"
        + "<li><b>Kanban:</b> pita 3 lajur di atas papan, bisa dilipat, ikut filter papan; kartu status biasa diberi penanda Live atau Paused.</li>"
        + "<li><b>Urutan kerja:</b> fase 1 daftar, fase 2 kanban (hanya UI), fase 3 Pause dan Resume di server dan adapter.</li>"
        + "</ul>"
    )
    nums = table(
        ["Ukuran (diukur)", "Sekarang", "Rancangan"],
        [
            ["Tinggi satu item, desktop", "254 px kartu", "%s px nyaman / %s px padat" % (m("row"), m("rowc"))],
            ["Tinggi satu item, ponsel 390", "262 px kartu", "%s px padat / %s px nyaman" % (m("pcompact"), m("pcard"))],
            ["12 task live, desktop", "610 px (6 tampil) / 1142 px (semua)", "%s px / %s px (semua)" % (m("ln-desktop-comfortable-12"), m("ln-desktop-compact-12"))],
            ["12 task live, ponsel", "strip geser 3784 px, 1,2 kartu terlihat", "%s px tinggi, 12 baris terlihat" % m("ln-phone-compact-12")],
            ["Task Paused di LIVE NOW", "hilang (bukan run)", "tetap, grup Paused"],
            ["LIVE NOW di kanban", "tidak ada", "pita %s px (2 kartu per lajur)" % m("band-desktop")],
        ],
        ["38%", "31%", "31%"],
    )
    body = (
        '<div class="grid g2" style="flex:1">'
        + "<div>%s<div style='height:4mm'></div><h3>Angka kunci</h3><div style='height:1.5mm'></div>%s%s</div>" % (asks, nums, cap("Sekarang: diukur di instance uji Wardmote %s dengan run tiruan. Rancangan: diukur dari mockup HTML yang sama dengan PDF ini (out/measures.json), bukan dari produk." % VERSION))
        + "<div><h3>Rekomendasi</h3><div style='height:1.5mm'></div>%s<div style='height:3mm'></div>%s</div>" % (rec, note("Keputusan paling berisiko ada di bagian D: arti Pause. Rancangan memilih jeda di titik aman di atas hold task yang sudah ada, bukan membekukan proses dan bukan pause agen. Bagian D memuat bukti kode untuk setiap pilihan dan apa yang belum terbukti.", "warn"))
        + "</div>"
    )
    return page(body, "Ringkasan", "Empat permintaan, satu arah")


def pin(n, x, y):
    return '<span class="pin num" style="left:%s%%;top:%s%%">%d</span>' % (x, y, n)


def a1():
    l_pins = [(1, 88, 42), (2, 70, 48.6), (3, 88, 53), (4, 88, 58.5), (5, 88, 63.2), (6, 88, 66.2), (7, 88, 70.8)]
    k_pins = [(8, 50, 31), (9, 88, 40.3), (10, 50, 47)]
    left = '<div class="anno" style="flex:none">%s%s</div>' % (img("before-phone-list.jpg", "height:150mm"), "".join(pin(*p) for p in l_pins))
    right = '<div class="anno" style="flex:none">%s%s</div>' % (img("before-phone-kanban.jpg", "height:150mm"), "".join(pin(*p) for p in k_pins))
    notes = (
        '<div class="fill sm">'
        + "<h3>Tampilan daftar (ponsel Zhafron, 1 run)</h3><div style='height:1mm'></div>"
        + '<ul class="b">'
        + '<li><span class="num">1</span> Baris agen: avatar, nama dipotong "Yoga (Apollo Runtime D...", pil Working, durasi. Pil warna hanya tahu 5 keadaan; tidak ada Paused.</li>'
        + '<li><span class="num">2</span> Jalur induk ZHA-5324 \u203a ZHA-6148 \u203a ZHA-6237 memakai dua baris penuh untuk 3 id tanpa judul.</li>'
        + '<li><span class="num">3</span> Judul task, yang paling penting, ada di baris ke-4 dan terpotong.</li>'
        + '<li><span class="num">4</span> Kutipan "Thinking: iding not to stop yet..." dipotong di tengah kata; dua baris untuk teks yang jarang berguna saat memindai.</li>'
        + '<li><span class="num">5</span> "Running wait 0s ago": aktivitas dan umur dalam satu baris tersendiri.</li>'
        + '<li><span class="num">6</span> Todo "0/10" baris tersendiri lagi.</li>'
        + '<li><span class="num">7</span> Empat aksi Open, Run, Steer, Stop sama kecilnya (sekitar 32 px); Stop yang merusak sejajar dengan Open.</li>'
        + "</ul>"
        + "<p style='margin-top:1.5mm'>Satu kartu memakan 34% tinggi layar ponsel (y 500 sampai 935 dari 1280 px). Kartu berikutnya ada di kanan dan harus digeser.</p>"
        + "<h3 style='margin-top:3mm'>Tampilan kanban (ponsel Zhafron)</h3><div style='height:1mm'></div>"
        + '<ul class="b">'
        + '<li><span class="num">8</span> Toolbar papan membungkus ke 2 baris (8 tombol).</li>'
        + '<li><span class="num">9</span> Pesan "Some board columns are showing up to 200 tasks" (IssuesList.tsx:2336, batas ISSUE_BOARD_COLUMN_RESULT_LIMIT = 200).</li>'
        + '<li><span class="num">10</span> LIVE NOW tidak ada. Penyebab di kode: <code>showListHeader</code> hanya benar saat <code>viewMode === "list"</code>, bukan sedang pencarian, dan bukan filter liveOnly (IssuesList.tsx:1876). Kartu task di kolom hanya punya titik biru kecil "Live" (KanbanBoard.tsx:345).</li>'
        + "</ul>"
        + "</div>"
    )
    body = '<div class="split" style="gap:6mm">%s%s%s</div>' % (left, right, notes)
    return page(body, "A \u00b7 Sebelum", "Dua tangkapan layar Zhafron, 14 Nov 2026, dengan anotasi")


def a2():
    body = (
        '<div class="grid g2">'
        + "<div>%s%s</div>" % (img("before-desktop-1.png", "width:100%"), cap("Desktop 1440 x 900, 1 run live. Bagian LIVE NOW setinggi 312 px untuk satu task; kartu 254 px."))
        + "<div>%s%s</div>" % (img("before-desktop-3.png", "width:100%"), cap("Desktop 1440 x 900, 3 run live. Tetap 312 px karena 3 kartu satu baris grid. Kartu Quiet 19m hanya dibedakan pil oranye kecil."))
        + "</div>"
        + note("Instance uji: Wardmote %s terpasang (commit %s), instance terpisah <code>zha6242</code> di port 3242, data tiruan lewat API dan baris <code>heartbeat_runs</code> berstatus running yang disisipkan langsung. Karena run tiruan tidak punya proses, kolom aktivitas berisi \"Waiting for the first event\" dan \"No message yet\". Tangkapan ponsel Zhafron di halaman sebelumnya memperlihatkan isi yang terisi." % (VERSION, BASE_SHA))
    )
    return page(body, "A \u00b7 Sebelum", "Desktop dengan 1 dan 3 run live")


def a3():
    meas = table(
        ["Diukur di instance uji", "Nilai"],
        [
            ["Tinggi LIVE NOW, 12 run, desktop, default (6 kartu + Show 6 more)", "610 px"],
            ["Sama, setelah Show 6 more", "1142 px"],
            ["Ukuran satu kartu desktop", "374 x 254 px"],
            ["Ponsel 390: tinggi satu kartu", "262 px"],
            ["Ponsel 390: lebar strip geser untuk 12 kartu", "3784 px (kartu 304 px)"],
            ["Ponsel 390: kartu yang terlihat tanpa geser", "1 penuh + 1 terpotong"],
            ["Kanban, desktop dan ponsel: LIVE NOW", "tidak dirender"],
        ],
        ["72%", "28%"],
    )
    body = (
        '<div class="grid g2">'
        + "<div>%s%s</div>" % (img("before-desktop-12.png", "width:100%"), cap("12 run live: dua baris kartu menekan daftar task ke bawah lipatan; 6 sisanya di balik Show 6 more."))
        + "<div>%s%s</div>" % (img("before-desktop-kanban-12.png", "width:100%"), cap("Papan dengan 12 run live yang sama: tidak ada LIVE NOW. Task live hanya bertitik biru di kolom In Progress."))
        + "</div>"
        + '<div class="split" style="gap:6mm;min-height:0">'
        + '<div style="flex:none">%s</div>' % img("before-phone-12.png", "height:74mm")
        + '<div class="fill">%s%s</div>' % (meas, cap("Ponsel gelap 390 x 844, 12 run: LIVE NOW berupa strip horizontal; ringkasan di kepala hanya \"4 quiet\" karena jumlah working disembunyikan di ponsel (TasksLiveNowSection, kelas hidden sm:inline-flex)."))
        + "</div>"
    )
    return page(body, "A \u00b7 Sebelum", "Skala: 12 run live di desktop, kanban, dan ponsel")


def a4():
    data = table(
        ["Yang tampil sekarang", "Sumber di kode"],
        [
            ["Avatar agen dengan pose per keadaan; avatar agen lain bila 1 task punya beberapa run", "LiveNowCard.tsx, LIVE_NOW_HEALTH_POSE"],
            ["Nama agen, durasi sejak run paling awal mulai", "LiveNowEntry.earliestStartedAt"],
            ["Keadaan: Starting (60 s pertama), Working, Thinking, Quiet (diam 2 menit), Stalled (diam 15 menit)", "live-now-health.ts, classifyLiveNowHealth"],
            ["Jalur induk, maksimal 3 tingkat, sisanya dipotong", "MAX_VISIBLE_ANCESTORS = 3"],
            ["Id dan judul task; kutipan pesan asisten terakhir", "lastAssistantSnippet"],
            ["Aktivitas: ikon tool, pesan status, umur", "describeLiveActivity"],
            ["Progres todo", "LiveNowTodoLine.tsx"],
            ["Kepala: jumlah, ringkasan quiet/stalled/working, strip avatar saat dilipat (5 desktop, 2 ponsel)", "TasksLiveNowSection.tsx"],
        ],
        ["68%", "32%"],
    )
    acts = table(
        ["Aksi sekarang", "Perilaku"],
        [
            ["Open", "Tautan ke task"],
            ["Run", "Tautan ke transkrip run"],
            ["Steer", "Form di kartu, Enter kirim, Esc batal; menyetir giliran yang sedang jalan"],
            ["Stop", "Dialog konfirmasi, lalu POST /heartbeat-runs/:id/cancel"],
            ["Lipat bagian", "Disimpan di localStorage per company"],
            ["Show N more", "Hanya desktop, di atas 6 kartu"],
        ],
        ["24%", "76%"],
    )
    probs = (
        '<ol class="sm" style="margin:0;padding-left:5mm">'
        + "<li>Kartu terlalu tinggi untuk dipindai: 254 sampai 262 px per task, 7 baris informasi bertumpuk.</li>"
        + "<li>Judul task, informasi paling penting, berada di bawah agen dan jalur induk.</li>"
        + "<li>Urutan hanya menaikkan Stalled; Quiet bercampur dengan Working.</li>"
        + "<li>Di ponsel strip horizontal menyembunyikan 10 dari 12 task tanpa tanda yang jelas.</li>"
        + "<li>Tidak ada Pause. Satu-satunya cara menghentikan adalah Stop (membatalkan run) atau pause agen (semua task agen itu).</li>"
        + "<li>Task yang di-pause lewat Pause work di detail task hilang dari LIVE NOW karena LIVE NOW hanya membaca run queued/running (agents.ts:6688, filter status).</li>"
        + "<li>Kanban tidak punya LIVE NOW sama sekali.</li>"
        + "<li>Detik berjalan memicu render ulang seluruh bagian setiap detik saat terbuka (useSecondTick di TasksLiveNowSection).</li>"
        + "</ol>"
    )
    body = '<div class="grid g2" style="flex:1"><div>%s<div style="height:3mm"></div>%s</div><div><h3>Masalah yang harus diselesaikan</h3><div style="height:1.5mm"></div>%s</div></div>' % (data, acts, probs)
    return page(body, "A \u00b7 Sebelum", "Inventaris data dan aksi yang ada sekarang")


def b1():
    rows3 = [by_state("working"), by_state("stalled"), by_state("paused")]
    desk_rows = '<div class="ui" style="width:1240px;padding:10px;background:var(--bg)"><div class="lst">%s</div></div>' % "".join(mock.row(x) for x in rows3)
    desk_compact = '<div class="ui" style="width:1240px;padding:10px;background:var(--bg)"><div class="lst">%s</div></div>' % "".join(mock.row_compact(x) for x in rows3)
    ph_card = '<div class="ui touch" style="width:366px;padding:8px;background:var(--bg)">%s</div>' % mock.phone_card(by_state("working"))
    ph_comp = '<div class="ui touch" style="width:366px;padding:8px;background:var(--bg)"><div class="lst">%s</div></div>' % "".join(mock.phone_compact(x) for x in rows3)
    zones = table(
        ["Zona", "Isi", "Kenapa"],
        [
            ["Identitas", "Avatar dengan titik keadaan; judul tebal satu baris; di bawahnya id, agen, dan jalur induk dua tingkat terakhir dengan awalan \u2026", "Judul dulu karena itu yang dicari mata; id tetap monospace untuk disalin"],
            ["Aktivitas", "Ikon tool + pesan status; baris kedua todo dengan bilah 46 px dan teks langkah", "Satu baris per fakta, tanpa kutipan panjang; kutipan pindah ke tooltip dan Open"],
            ["Keadaan", "Chip dengan kata dan ikon, durasi di bawahnya", "Kata selalu ada, warna bukan satu-satunya penanda"],
            ["Aksi", "Pause/Resume berlabel di posisi pertama; Steer, Open ikon; Stop di menu More", "Aksi berisiko keluar dari jangkauan klik tidak sengaja"],
        ],
        ["13%", "52%", "35%"],
    )
    body = (
        "<div>%s%s</div>" % (z(desk_rows, 0.81), cap("Desktop, kerapatan nyaman: 3 baris (Working, Stalled, Paused). Tinggi baris %s px." % m("row")))
        + "<div>%s%s</div>" % (z(desk_compact, 0.81), cap("Desktop, kerapatan padat: satu baris %s px, aksi Pause/Resume dan More berupa ikon 28 px." % m("rowc")))
        + '<div class="split" style="gap:5mm">'
        + '<div style="flex:none">%s%s</div>' % (z(ph_card, 0.6), cap("Ponsel nyaman: %s px." % m("pcard")))
        + '<div style="flex:none">%s%s</div>' % (z(ph_comp, 0.6), cap("Ponsel padat: %s px per baris." % m("pcompact")))
        + '<div class="fill">%s</div>' % zones
        + "</div>"
    )
    return page(body, "B \u00b7 Daftar baru", "Anatomi baris: identitas, aktivitas, keadaan, aksi")


def b2():
    sec = mock.section_desktop(ITEMS, "comfortable", limit=4)
    d = mock.desk(sec, "light", 1240, tail=False)
    body = (
        z(d, 0.73)
        + cap("Desktop terang, kerapatan nyaman, 12 task live. Needs attention (3) dan Paused (2) selalu tampil; hanya Working yang dibatasi 4 baris lalu Show 3 more working. Chip filter di kepala: All, Needs attention, Working, Paused. Kepala tetap satu baris di 1240 px.")
    )
    return page(body, "B \u00b7 Daftar baru", "Desktop terang, nyaman")


def b3():
    sec = mock.section_desktop(ITEMS, "compact")
    d = mock.desk(sec, "dark", 1240, tail=False)
    collapsed_l = '<div class="ui" style="width:1240px;padding:8px 12px;background:var(--bg)">%s</div>' % mock.section_desktop(ITEMS, collapsed=True)
    collapsed_d = '<div class="ui dark" style="width:1240px;padding:8px 12px;background:var(--bg)">%s</div>' % mock.section_desktop(ITEMS, collapsed=True)
    body = (
        z(d, 0.66)
        + cap("Desktop gelap, kerapatan padat: 12 task dalam %s px tanpa Show more." % m("ln-desktop-compact-12"))
        + z(collapsed_l, 0.66)
        + z(collapsed_d, 0.66)
        + cap("Keadaan dilipat, terang dan gelap: satu baris 36 px dengan strip avatar dan jumlah per grup. Pilihan lipat dan kerapatan disimpan di localStorage per company seperti sekarang.")
    )
    return page(body, "B \u00b7 Daftar baru", "Desktop gelap, padat, dan keadaan dilipat")


def b4():
    p1 = mock.phone(mock.section_phone([ITEMS[0], ITEMS[3], ITEMS[10]], "comfortable"), "light", 844)
    p2 = mock.phone(mock.section_phone(ITEMS, "compact", limit=2), "dark", 844)
    p3 = mock.phone(mock.section_phone(ITEMS, collapsed=True) + '<div class="list2" style="margin-top:6px"><div>ZHA-35 Backlog item 20</div><div>ZHA-34 Backlog item 19</div><div>ZHA-33 Backlog item 18</div><div>ZHA-32 Backlog item 17</div></div>', "light", 844)
    sheet = (
        '<div class="scrim"></div><div class="sheet"><div class="grab"></div>'
        + '<div style="font-size:15px;font-weight:650">ZHA-6241 \u00b7 Yoga (Apollo Runtime Dev)</div>'
        + '<div class="t3" style="font-size:13px;margin:2px 0 8px">main red: test_reader_is_unsafe_while_every_reader_is_parked</div>'
        + '<div class="mi">%sOpen task</div><div class="mi">%sRun transcript</div><div class="mi">%sSteer</div><div class="mi">%sPause subtree</div>' % (mock.ic("arrow-up-right"), mock.ic("scroll-text"), mock.ic("message-square"), mock.ic("git-branch"))
        + '<div class="mi" style="color:var(--bad)">%sStop run\u2026</div>' % mock.ic("square")
        + "</div>"
    )
    p4 = mock.phone(mock.section_phone(ITEMS, "compact", limit=2), "dark", 844, overlay=sheet)
    row = '<div class="split" style="gap:4mm;justify-content:space-between">%s%s%s%s</div>' % tuple(z(p, 0.555) for p in (p1, p2, p3, p4))
    caps = (
        '<div class="grid" style="grid-template-columns:repeat(4,1fr);gap:4mm">'
        + cap("Terang, nyaman: aksi 44 px; Pause di kolom lebar, Steer, Open, More ikon 44 px.")
        + cap("Gelap, padat (default ponsel): 1 baris %s px, satu tombol 44 px per baris. Needs attention dan Paused selalu tampil; Working dipotong ke 2 lalu Show more. Ketuk baris membuka lembar aksi." % m("pcompact"))
        + cap("Dilipat: satu baris; penanda \"need attention\" dan \"paused\" tetap terlihat.")
        + cap("Lembar More: Stop di posisi terakhir, merah, tetap dengan dialog konfirmasi yang sama seperti sekarang.")
        + "</div>"
    )
    return page(row + caps, "B \u00b7 Daftar baru", "Ponsel 390 px: nyaman, padat, dilipat, menu More")


def b5():
    items = [by_state(s) for s in STATES]
    desk_rows = '<div class="ui" style="width:1240px;padding:10px;background:var(--bg)"><div class="lst">%s</div></div>' % "".join(mock.row(x) for x in items)
    ph = '<div class="ui touch dark" style="width:366px;padding:8px;background:var(--bg)"><div class="lst">%s</div></div>' % "".join(mock.phone_compact(x) for x in items)
    body = (
        '<div class="split" style="gap:5mm">'
        + "<div style='flex:none'>%s</div>" % z(desk_rows, 0.6)
        + "<div style='flex:none'>%s</div>" % z(ph, 0.6)
        + "</div>"
        + table(
            ["Keadaan", "Kapan", "Aksi utama", "Sumber data"],
            [
                ["Starting", "60 s pertama run", "Pause", "run.startedAt"],
                ["Working / Thinking", "Ada aktivitas dalam 2 menit", "Pause", "run events, currentToolName"],
                ["Quiet / Stalled", "Diam 2 menit / 15 menit", "Pause, Steer", "lastLiveActivityMs (tetap)"],
                ["Pausing", "Hold aktif, run masih hidup", "(menunggu) More \u203a Stop now", "hold + run status"],
                ["Paused", "Hold aktif, tidak ada run", "Resume", "endpoint baru paused-tasks"],
                ["Resuming", "Hold dilepas, wake antre atau run queued", "(menunggu)", "release + run queued"],
                ["Pause failed", "Run tidak berhenti dalam 120 s atau cancel gagal", "Retry pause, Stop", "activity issue.tree_hold_run_interrupt_failed"],
            ],
            ["14%", "36%", "22%", "28%"],
        )
    )
    return page(body, "B \u00b7 Daftar baru", "Semua keadaan: desktop terang dan ponsel gelap")


def b6():
    one = '<div class="ui" style="width:1240px;padding:10px;background:var(--bg)">%s</div>' % mock.section_desktop([by_state("working")], "comfortable")
    multi = '<div class="ui" style="width:1240px;padding:10px;background:var(--bg)"><div class="lst">%s</div></div>' % mock.row(MULTI)
    steer_row = mock.row(by_state("thinking"))
    steer = (
        '<div class="ui" style="width:1240px;padding:10px;background:var(--bg)"><div class="lst">%s' % steer_row
        + '<div style="padding:10px 12px 12px 58px;border-top:1px solid var(--line-soft)"><div style="border:1px solid var(--focus);border-radius:10px;padding:10px 12px;font-size:13px;box-shadow:0 0 0 3px var(--accent-soft)">Use the swimlane only as the rejected option; keep the band.</div>'
        + '<div class="row" style="margin-top:8px"><span class="t3" style="font-size:12px">Enter to send \u00b7 Esc to cancel \u00b7 steers the running turn</span><span style="flex:1"></span><span class="btn ghost">Cancel</span><span class="btn pri">Send</span></div></div></div></div>'
    )
    dialog = (
        '<div class="ui" style="width:520px;padding:18px;background:var(--bg)"><div style="background:var(--bg-2);border:1px solid var(--line);border-radius:14px;padding:18px;box-shadow:var(--shadow-2)">'
        + '<div style="font-size:16px;font-weight:650">Stop Yoga (Apollo Runtime Dev)\'s run?</div>'
        + '<div class="t2" style="font-size:13px;margin-top:6px">The run is cancelled now. A tool in progress is cut off. Use Pause instead to keep the session and continue later.</div>'
        + '<div class="row" style="margin-top:14px;justify-content:flex-end"><span class="btn">Keep running</span><span class="btn">%sPause instead</span><span class="btn danger">Stop run</span></div>' % mock.ic("pause")
        + "</div></div>"
    )
    body = (
        "<div>%s%s</div>" % (z(one, 0.64), cap("Satu task: kepala dan satu baris, tanpa chip filter berlebih (hanya All dan grup yang berisi)."))
        + "<div>%s%s</div>" % (z(multi, 0.64), cap("Banyak run dalam satu task: dua avatar bertumpuk, \"2 runs\". Pause menahan task, jadi kedua run berhenti; Steer membuka pilihan agen."))
        + '<div class="split" style="gap:5mm">'
        + "<div style='flex:none'>%s%s</div>" % (z(steer, 0.54), cap("Steer tetap di dalam baris, seperti form sekarang, dengan label yang menjelaskan efeknya."))
        + "<div style='flex:none;width:86mm'>%s%s</div>" % (z(dialog, 0.6), cap("Stop tetap memakai dialog konfirmasi; dialog menawarkan Pause sebagai jalan yang tidak memotong tool."))
        + "</div>"
        + note("Kosong: bagian LIVE NOW tidak dirender bila tidak ada run live dan tidak ada task Paused, sama seperti sekarang. Tidak ada keadaan kosong bergambar karena halaman Tasks sudah punya daftar di bawahnya.")
    )
    return page(body, "B \u00b7 Daftar baru", "Kasus tepi: satu task, banyak run, Steer, Stop")


PAGES = [cover, summary, a1, a2, a3, a4, b1, b2, b3, b4, b5, b6]
