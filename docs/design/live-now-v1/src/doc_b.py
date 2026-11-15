from base import ITEMS, by_state, cap, img, m, note, page, table, z
import mock


def status_board(extra_markers=True, cols=5):
    ip = [
        mock.scard("ZHA-6241", "main red: test_reader_is_unsafe_while_every_reader_is_parked", "Yoga (Apollo Runtime Dev)", 30, ("working", "Live")),
        mock.scard("ZHA-6240", "Review PR #431: kanban live band", "Hendra (Reviewer)", 150, ("stalled", "Stalled")),
        mock.scard("ZHA-6161", "Local Browser: refs.prune() pada snapshot bercursor", "Laras (Researcher)", 170, ("paused", "Paused")),
    ]
    data = [
        ("Backlog", "var(--status-b, #52585d)", [mock.scard("ZHA-5401", "Backlog item 17: follow-up from weekly review"), mock.scard("ZHA-5402", "Backlog item 11: follow-up from weekly review")], 15),
        ("Todo", "#cc7a00", [mock.scard("ZHA-6238", "Keputusan: bundel coworker per tim"), mock.scard("ZHA-6228", "Lab0 backup S3 rotation proof", "Dimas (Infra)", 220)], 6),
        ("In progress", "#2563eb", ip, 15),
        ("In review", "#7c3aed", [mock.scard("ZHA-6236", "Wardmote kanban: live marker on status cards", "Raka (OSS Dev)", 330, ("working", "Live"))], 4),
        ("Blocked", "#dc2626", [mock.scard("ZHA-6201", "Release train November")], 2),
    ]
    return '<div class="board">%s</div>' % "".join(mock.column(n, c, cards, k) for n, c, cards, k in data[:cols])


def c1():
    inner = mock.band(ITEMS, per_lane=2) + status_board()
    d = mock.desk(inner, "light", 1400, kanban=True)
    body = (
        z(d, 0.68)
        + cap("Pilihan C1, desktop terang: pita LIVE NOW di atas papan, tiga lajur keadaan, 2 kartu per lajur lalu +n more. Pita bisa dilipat ke satu baris 36 px. Kartu task live di kolom status ikut diberi penanda Live, Stalled, atau Paused.")
    )
    return page(body, "C \u00b7 Kanban", "Pilihan C1: pita LIVE NOW dengan lajur per keadaan")


def c2():
    w_items = [by_state("working"), by_state("stalled")]
    cells = []
    cells.append('<div class="lab">Live now</div>')
    for i in range(5):
        content = ""
        if i == 2:
            content = "".join(mock.kcard(x) for x in w_items)
        if i == 3:
            content = mock.kcard(by_state("thinking"))
        cells.append('<div class="cell">%s</div>' % content)
    heads = '<div></div>' + "".join('<div class="lab">%s</div>' % n for n in ["Backlog", "Todo", "In progress", "In review", "Blocked"])
    swim = '<div class="ui" style="width:1400px;padding:12px;background:var(--bg)"><div class="swim">%s%s</div></div>' % (heads, "".join(cells))
    comp = table(
        ["Kriteria", "C1 Pita 3 lajur", "C2 Swimlane"],
        [
            ["Bentuk kanban", "Ya, lajur Needs attention, Working, Paused", "Ya, satu baris melintang kolom status"],
            ["Task yang butuh perhatian terlihat duluan", "Ya, lajur kiri", "Tidak, tersebar per kolom status"],
            ["Paused dikelompokkan", "Ya, lajur sendiri", "Tidak, ikut kolom status task"],
            ["Ruang terpakai, 12 task, desktop", "pita %s px (2 kartu per lajur)" % m("band-desktop"), "baris setinggi kolom terpenuh; 4 dari 5 sel nyaris kosong (task live hampir selalu In progress)"],
            ["Ponsel 390", "3 lajur geser, sama dengan kolom papan", "Swimlane melebar ke semua kolom, 6 layar geser"],
            ["Kode", "Komponen baru LiveNowBoardBand memakai model yang sama dengan daftar", "Mengubah grid KanbanBoard dan virtualisasi kolom"],
        ],
        ["28%", "36%", "36%"],
        rec_rows=(),
    )
    body = (
        z(swim, 0.62)
        + cap("Pilihan C2, swimlane: satu baris Live now di atas kolom status. Di data nyata hampir semua task live berstatus In progress, jadi 4 dari 5 sel kosong.")
        + '<div class="split" style="gap:6mm"><div class="fill">%s</div><div style="width:85mm">%s</div></div>' % (
            comp,
            note("<b>Pilih C1.</b> Pertanyaan saat membuka LIVE NOW adalah \"mana yang perlu saya tangani\", bukan \"status task apa yang sedang jalan\". C1 menjawabnya di lajur kiri, mengelompokkan Paused seperti permintaan Zhafron, memakai ruang tetap (2 kartu per lajur), dan memakai model data yang sama dengan daftar sehingga tidak ada dua konvensi. C2 menggandakan informasi yang sudah ada di kolom In progress."))
    )
    return page(body, "C \u00b7 Kanban", "Pilihan C2: swimlane, dan perbandingan")


def c3():
    tail = '<div class="board" style="grid-auto-columns:300px;margin-top:10px">%s</div>' % "".join(
        mock.column(n, c, cards, k) for n, c, cards, k in [
            ("Backlog", "#52585d", [mock.scard("ZHA-5388", "DCM SO Sparepart: konfigurasi + perbaikan data"), mock.scard("ZHA-6161", "Local Browser: refs.prune()", "Raka (OSS Dev)", 330)], 15),
            ("Todo", "#cc7a00", [mock.scard("ZHA-6238", "Keputusan: bundel coworker")], 6),
        ])
    p1 = mock.phone(mock.band(ITEMS, per_lane=2, phone_mode=True), "light", 844, kanban=True)
    p2 = mock.phone(mock.band(ITEMS, per_lane=2, phone_mode=True), "dark", 844, kanban=True)
    p3 = mock.phone(mock.band(ITEMS, phone_mode=True, collapsed=True) + tail, "light", 844, kanban=True)
    row = '<div class="split" style="gap:6mm;justify-content:center">%s%s%s</div>' % tuple(z(p, 0.56) for p in (p1, p2, p3))
    caps = (
        '<div class="grid g3">'
        + cap("Terang: lajur Needs attention di kiri, lebar 262 px; lajur Working mengintip di kanan sebagai tanda geser. Geser memakai scroll-snap seperti kolom papan.")
        + cap("Gelap: sama, tombol Pause/Resume di kartu 44 px.")
        + cap("Dilipat: satu baris dengan penanda need attention dan paused; papan status langsung di bawahnya.")
        + "</div>"
    )
    return page(row + caps, "C \u00b7 Kanban", "C1 di ponsel 390 px: geser horizontal, terang dan gelap")


def c4():
    board = '<div class="ui" style="width:1400px;padding:12px;background:var(--bg)">%s</div>' % status_board()
    rules = table(
        ["Hal", "Aturan di rancangan", "Sekarang"],
        [
            ["Filter papan (assignee, project, label, status)", "Berlaku juga untuk pita dan daftar LIVE NOW. Task live yang tersaring muncul sebagai chip \"n hidden by filters\" yang bisa diklik untuk menampilkannya.", "Daftar: filter tidak berlaku ke LIVE NOW. Kanban: tidak ada LIVE NOW."],
            ["Pencarian", "Pita dan daftar menyaring dengan pencarian yang sama.", "Bagian LIVE NOW disembunyikan saat mencari (IssuesList.tsx:1876)."],
            ["Batas 200 kartu per kolom", "Pita tidak bergantung pada batas itu: datanya dari live-runs dan paused-tasks, task yang belum dimuat diambil lewat query detail seperti sekarang.", "Pesan \"showing up to 200 tasks\" (IssuesList.tsx:2336)."],
            ["Batas live-runs", "Tetap: maksimal 50 run per permintaan (agents.ts:6699). Di atas 50 run, pita menulis \"50+\".", "Sama, tidak terlihat."],
            ["Penanda di kartu status", "Live (biru), Stalled atau Quiet (warna keadaan), Paused (abu dengan ikon). Kata selalu ada.", "Titik biru Live saja (KanbanBoard.tsx:345)."],
            ["Klik kartu di pita", "Membuka task; tombol di kartu hanya Pause/Resume, sisanya lewat More.", "-"],
        ],
        ["20%", "52%", "28%"],
    )
    body = z(board, 0.66) + cap("Kolom status dengan penanda keadaan live pada kartu task.") + rules
    return page(body, "C \u00b7 Kanban", "Interaksi pita dengan filter, pencarian, dan batas kolom")


def d1():
    opts = table(
        ["Pilihan", "Arti untuk pengguna", "Kelayakan dari kode", "Lease, restart, token", "Risiko"],
        [
            ["<b>(a) Hold task + berhenti di titik aman</b> <span class=\"tag rec\">rekomendasi</span>", "Task berhenti setelah langkah yang sedang jalan selesai. Sesi agen disimpan. Resume melanjutkan sesi yang sama.", "Hold, gerbang antrean, dan wake saat dilepas sudah ada. Perlu: hold cakupan task, permintaan berhenti di titik aman lewat registry steer omp_local (execute.ts:1111), endpoint paused-tasks.", "Lease dilepas seperti Stop. Hold berupa baris DB, bertahan saat restart. Token 0 selama Paused.", "Adapter selain omp_local berhenti segera. Tunggu maksimal 120 s, lalu Stop now ditawarkan."],
            ["(a0) Hold yang sudah ada, berhenti segera", "Sama dengan tombol Pause work di detail task hari ini.", "Sudah jalan: IssueDetail.tsx:4133 memanggil POST /issues/:id/tree-holds mode pause; route membatalkan run aktif (issue-tree-control.ts:161).", "Sama dengan (a).", "Tool yang sedang jalan terpotong; omp hanya menandai sesi utuh bila tidak ada tool berjalan (execute.ts:1257)."],
            ["(b) Pause agen", "Semua task agen itu berhenti.", "Ada: POST /agents/:id/pause (agents.ts:5461) membatalkan semua run agen dengan errorCode agent_paused (heartbeat.ts:5611).", "Semua lease agen dilepas. Token 0.", "Terlalu luas: satu klik menghentikan task lain milik agen. Pernah tertahan di Pausing (ZHA-2689)."],
            ["(c) Bekukan proses", "Proses agen dibekukan di memori.", "Tidak ada jalur. Run jarak jauh dan sandbox tidak bisa dibekukan dari server.", "Lease dan memori tetap dipegang. Restart dan rilis memotong proses (drain di recovery.ts:958, ZHA-6214).", "Stream ke penyedia model putus. Health menandai Quiet setelah 2 menit dan Stalled setelah 15 menit (live-now-health.ts:20-21)."],
        ],
        ["17%", "21%", "27%", "17%", "18%"],
        rec_rows=(0,),
    )
    body = (
        note("Definisi yang diusulkan: <b>Pause menahan satu task.</b> Run yang sedang berjalan selesai sampai titik aman lalu berakhir, sesi disimpan, tidak ada wake baru sampai Resume. Resume melepas hold dan membangunkan agen yang ditugaskan; run baru melanjutkan sesi yang sama. Bukan run baru dengan status \"paused\": HEARTBEAT_RUN_STATUSES tidak punya keadaan itu (constants.ts:949), dan run yang menggantung tanpa proses justru masalah yang ingin dihindari.")
        + opts
        + note("Temuan penting: pause per task <b>sudah ada</b> di server sebagai tree hold (dipakai tombol Pause work di detail task), tetapi tidak terlihat di LIVE NOW karena LIVE NOW hanya membaca run queued dan running. Jadi pekerjaan utama bukan membuat pause baru, melainkan membuat hold terlihat, membatasi cakupannya ke satu task, dan menghentikan run di titik aman.", "ok")
    )
    return page(body, "D \u00b7 Pause dan Resume", "Arti pause untuk satu task: empat pilihan nyata")


def d2():
    ev = table(
        ["Fakta", "Bukti"],
        [
            ["Membuat hold pause menahan pohon task, membatalkan run aktif, dan membatalkan wake yang belum diklaim", "server/src/routes/issue-tree-control.ts:123, :161-213, :218-245"],
            ["Run yang diklaim saat hold aktif dibatalkan kecuali wake interaksi yang terverifikasi", "server/src/services/heartbeat/queue.ts:1077-1095"],
            ["Wake baru saat hold aktif dilewati dengan alasan issue_tree_hold_active dan dicatat issue.tree_hold_wakeup_deferred", "queue.ts:2708-2738"],
            ["Melepas hold bisa membangunkan agen (metadata.wakeAgents) setelah cek blocker", "issue-tree-control.ts:413-470"],
            ["Pembatalan hold dicap sebagai tindakan operator agar recovery tidak menganggapnya task terdampar", "issue-tree-control.ts:166-168"],
            ["omp_local mengembalikan sessionParams juga saat dibatalkan; sesi ditandai utuh bila tidak ada tool berjalan", "packages/adapters/omp-local/src/server/execute.ts:1225-1231, :1257-1259"],
            ["Sesi disimpan setelah run berakhir kecuali adapter menyatakan sesi tidak tersedia", "server/src/services/heartbeat/run-completion.ts:1061-1075"],
            ["Task percakapan: run yang dibatalkan tidak menyimpan sesi", "server/src/services/heartbeat/run-state.ts:1426-1428"],
            ["Lease lingkungan dilepas saat run berakhir; status cancelled menjadi released", "server/src/services/heartbeat/run-control.ts:151-155, :268"],
            ["Restart server menginterupsi run yang berjalan", "server/src/services/heartbeat/recovery.ts:958"],
            ["Komentar board ditolak 409 saat hold aktif; komentar agen tetap boleh", "server/src/routes/issues.ts:7285-7300"],
            ["Registry steer per run sudah ada untuk omp RPC; jalur yang sama bisa membawa permintaan berhenti", "execute.ts:1111-1113, rpc-session.ts:308"],
        ],
        ["62%", "38%"],
    )
    probe = table(
        ["Dijalankan di instance uji 2026.1114.3", "Hasil"],
        [
            ["POST /issues/:id/tree-holds mode pause pada task dengan run tiruan", "201, hold aktif, 1 anggota"],
            ["GET /issues/:id/tree-control/state", "activePauseHold ada"],
            ["Komentar board saat hold aktif", "409 \"Task is paused. Resume it before sending a message.\""],
            ["Komentar board tanpa hold (kontrol)", "201"],
            ["Run tiruan 10 s setelah hold", "masih running: run tiruan tanpa proses, jadi bukan bukti perilaku run sungguhan"],
            ["POST .../tree-holds/:holdId/release", "200"],
        ],
        ["60%", "40%"],
    )
    body = '<div class="grid g21" style="flex:1"><div>%s</div><div>%s%s</div></div>' % (ev, probe, cap("Probe dijalankan 15 Nov 2026 lewat API instance uji; skrip dan data dihapus setelahnya."))
    return page(body, "D \u00b7 Pause dan Resume", "Bukti dari kode dan dari instance uji")


def d3():
    mapping = table(
        ["Keadaan UI", "Fakta server", "Masuk LIVE NOW karena"],
        [
            ["Working, Thinking, Quiet, Stalled", "run queued/running, tanpa hold", "live-runs"],
            ["Pausing", "hold aktif dan run masih queued/running", "live-runs + hold"],
            ["Paused", "hold aktif, tidak ada run", "paused-tasks (baru)"],
            ["Resuming", "hold dilepas, wake atau run queued belum berjalan", "live-runs (queued) + penanda dari pelepasan"],
            ["Pause failed", "hold aktif, run masih hidup 120 s setelah permintaan, atau activity issue.tree_hold_run_interrupt_failed", "live-runs + hold"],
        ],
        ["20%", "52%", "28%"],
    )
    body = mock.state_diagram() + mapping
    return page(body, "D \u00b7 Pause dan Resume", "Alur keadaan run dan task, termasuk Paused")


def d4():
    qa = table(
        ["Pertanyaan wajib", "Jawaban rancangan", "Dasar"],
        [
            ["Lease dan workspace saat Paused", "Tidak ada run, jadi lease lingkungan dilepas seperti Stop (sandbox ephemeral dihancurkan, warm reuse_by_environment dipertahankan sesuai kebijakan). Kunci eksekusi task dilepas. Folder kerja proyek tidak dihapus oleh pembatalan (belum diuji di disk).", "run-control.ts:151-155, :268"],
            ["Watchdog, stalled, batas waktu", "Tidak berlaku: semuanya menempel pada run, dan Paused tidak punya run. Pembatalan karena hold dicap tindakan operator sehingga recovery tidak membuat insiden.", "issue-tree-control.ts:166-168"],
            ["Restart atau upgrade", "Paused bertahan (baris hold di DB, tidak ada proses yang bisa dipotong). Pausing saat restart: drain menginterupsi run, gerbang hold mencegah klaim ulang, hasilnya Paused.", "recovery.ts:958, queue.ts:1077"],
            ["Biaya token saat Paused", "Nol: tidak ada proses dan wake ditahan. Resume membayar satu kali tulis cache sebesar konteks sesi bila jeda lebih lama dari TTL cache penyedia (belum diukur).", "queue.ts:2708"],
            ["Siapa boleh", "Pengguna board dengan akses company, sama seperti Stop dan Pause work sekarang. Agen hanya lewat API dengan otoritas company:issue_control, tidak berubah.", "IssueDetail.tsx:3349, issue-tree-control.ts:124"],
            ["Activity log", "Sudah ada: issue.tree_hold_created, issue.tree_hold_run_interrupted, issue.tree_hold_wakeup_deferred, issue.tree_hold_released. Tambah metadata source live_now dan stopAt.", "issue-tree-control.ts:148-478"],
            ["Komentar saat Paused", "Agen: masuk, wake ditunda. Manusia: sekarang 409. Usul: diterima dan diberi label \"waits for Resume\", tanpa wake (keputusan 6).", "issues.ts:7285"],
            ["Paused lalu Stop", "Pausing: More \u203a Stop now membatalkan run segera, hasil Paused. Paused: tidak ada run; More \u203a End pause melepas hold tanpa wake dan task keluar dari LIVE NOW.", "-"],
            ["Berapa lama sebelum diingatkan", "24 jam lalu 72 jam, item inbox ke orang yang mem-pause. Tanpa auto-resume (keputusan 7).", "-"],
        ],
        ["17%", "63%", "20%"],
    )
    return page(qa, "D \u00b7 Pause dan Resume", "Pertanyaan wajib dan jawabannya")


def d5():
    api = table(
        ["Perubahan", "Bentuk", "Kontrak"],
        [
            ["Cakupan hold", "<code>scope: \"task\" | \"subtree\"</code> di POST /issues/:id/tree-holds, default subtree (perilaku sekarang). Kolom <code>issue_tree_holds.scope</code>, migrasi tambah kolom dengan default.", "validators/issue-tree-control.ts, openapi.ts"],
            ["Berhenti di titik aman", "<code>stopAt: \"safe_point\" | \"now\"</code>, default now. safe_point: server meminta adapter berhenti setelah tool berjalan selesai, lalu cancelRun setelah 120 s.", "adapter-steer-registry, omp-local rpc-session"],
            ["Daftar task Paused", "GET /companies/:companyId/paused-tasks: hold aktif mode pause dengan judul task, siapa, kapan, ringkasan run terakhir, todo. Izin sama dengan live-runs.", "route baru, openapi.ts"],
            ["Event langsung", "Event perubahan hold di kanal live yang sudah ada, untuk invalidasi query; tanpa polling.", "LiveUpdatesProvider"],
            ["Komentar saat Paused", "Komentar board diterima, ditandai menunggu Resume, tanpa wake.", "issues.ts:7285"],
            ["Pengingat", "Job terjadwal: hold aktif lebih dari 24 jam dan 72 jam membuat item inbox.", "scheduler yang ada"],
            ["MCP", "Tidak ada tool baru; kontrak MCP dibuat ulang karena skema hold berubah.", "pnpm check:mcp-tools"],
        ],
        ["16%", "56%", "28%"],
    )
    w = by_state("working")
    p = dict(w, state="pausing", act=("loader-circle", "Stops after the current step: wait"))
    pd = dict(w, state="paused", act=("pause", "Last: running wait"), dur="paused just now by Zhafron", chipx="")
    pf = by_state("failed")
    seq = '<div class="ui" style="width:1240px;padding:10px;background:var(--bg)"><div class="lst">%s%s%s%s</div></div>' % (mock.row(w), mock.row(p), mock.row(pd), mock.row(pf))
    toasts = (
        '<div class="ui" style="width:470px;padding:10px;background:var(--bg);display:flex;flex-direction:column;gap:8px">'
        + '<div class="toast">%s<span style="flex:1">Pausing ZHA-6241. It stops after the current step.</span><span class="btn">Stop now</span></div>' % mock.ic("pause")
        + '<div class="toast">%s<span style="flex:1">ZHA-6241 paused. Session saved.</span><span class="btn">Resume</span></div>' % mock.ic("check")
        + '<div class="toast">%s<span style="flex:1">Couldn\'t pause ZHA-6228: the run did not stop within 120 s.</span><span class="btn">Stop run</span></div>' % mock.ic("circle-alert")
        + '<div style="border:1px solid var(--line);border-radius:12px;background:var(--bg-2);padding:10px 12px;font-size:13px"><div class="row t2">%sThis task is paused. Your message waits until Resume.</div><div style="margin-top:8px;border:1px solid var(--line);border-radius:8px;padding:8px;color:var(--ink-3)">Write a message</div></div>' % mock.ic("pause")
        + "</div>"
    )
    body = (
        api
        + '<div class="split" style="gap:5mm"><div style="flex:none;width:180mm">%s%s</div><div style="flex:none;width:76mm">%s%s</div></div>' % (
            z(seq, 0.55), cap("Urutan satu task: Working, Pausing, Paused, dan contoh Pause failed."),
            z(toasts, 0.6), cap("Umpan balik: toast dengan satu aksi lanjutan, dan composer task saat Paused bila keputusan 6 disetujui."))
    )
    return page(body, "D \u00b7 Pause dan Resume", "Perubahan API dan skema, dan alur di layar")


PAGES = [c1, c2, c3, c4, d1, d2, d3, d4, d5]
