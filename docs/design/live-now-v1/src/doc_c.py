from base import m, note, page, table, cap


def e1():
    ix = table(
        ["Hal", "Rancangan"],
        [
            ["Gerak", "Pergantian chip keadaan: cross-fade --motion-duration-fast (160 ms) dengan --motion-ease-standard. Baris baru: fade-in 160 ms tanpa animasi tinggi. Baris pindah grup: langsung, tanpa animasi posisi. Semua token sudah ada di ui/src/motion-tokens.css."],
            ["Reduced motion", "Tanpa animasi; ikon spinner Pausing dan Resuming diganti ikon statis; titik live tidak berdenyut."],
            ["Tanpa loncatan layout", "Tinggi baris tetap per kerapatan; durasi memakai tabular-nums; useAboveViewportResizeCompensation yang sudah ada tetap menahan daftar di bawahnya saat bagian berubah tinggi."],
            ["Aksesibilitas", "Tombol berlabel lengkap (\"Pause Yoga's run on ZHA-6241\"). Fokus tetap di tombol yang sama dari Pause ke Pausing ke Resume (aria-disabled, bukan disabled). Live region yang ada diperluas: paused, resumed, pause failed, selain quiet dan stalled. Keadaan selalu berupa kata, tidak hanya warna."],
            ["Kontras", "Teks mockup diperiksa otomatis di render PDF ini, terang dan gelap (angka di halaman F). Tombol Paused memakai --accent dan --accent-ink yang sama dengan tombol utama aplikasi."],
            ["Papan ketik (desktop)", "g l fokus ke LIVE NOW; j dan k pindah baris (sama dengan inbox); p Pause atau Resume; s Steer; Enter buka; titik membuka More. Stop sengaja tanpa pintasan. Tidak bentrok dengan pintasan global di KeyboardShortcutsCheatsheet (/, c, [, ], ?, g i, g c)."],
            ["Umpan balik", "Setiap aksi: chip di baris berubah seketika, toast dengan satu aksi lanjutan (Stop now, Resume, Retry)."],
            ["Galat", "Kalimat dari server plus langkah berikutnya: \"Couldn't pause ZHA-6228: the run did not stop within 120 s. Stop run?\""],
        ],
        ["16%", "84%"],
    )
    research = table(
        ["Produk", "Yang diambil", "Yang tidak diambil"],
        [
            ["Linear (daftar issue)", "Baris satu sampai dua tingkat, j dan k, ikon status selalu dengan kata", "View kustom, grup bertingkat"],
            ["Vercel (Deployments)", "Kolom keadaan + durasi rata kanan, satu baris per deployment", "Panel log di dalam daftar"],
            ["GitHub Actions", "Cancel terpisah dari aksi utama dan butuh konfirmasi; tidak ada pause di sana, jadi arti pause harus kita tentukan sendiri", "Matriks job"],
            ["Temporal (Activity Pause)", "Pause berlaku di batas berikutnya, Unpause langsung jalan, Paused tampil sebagai keadaan sendiri (docs.temporal.io/activity-operations)", "Reset dan update options"],
            ["Buildkite", "Pengelompokan berdasarkan keadaan, keadaan menunggu manusia ditampilkan terpisah (dasar grup Needs attention dan Pause failed)", "Grafik langkah pipeline"],
        ],
        ["20%", "52%", "28%"],
    )
    body = '<div class="grid g2" style="flex:1"><div>%s</div><div>%s%s</div></div>' % (ix, research, note("Rujukan di atas dari dokumentasi publik dan pemakaian produk, bukan uji pengguna. Skill impeccable dan frontend-ui-engineering dipakai sebagai daftar periksa: keadaan lengkap, hierarki judul, target sentuh 44 px, tanpa warna sebagai satu-satunya penanda.", ""))
    return page(body, "E \u00b7 Interaksi dan kualitas", "Gerak, aksesibilitas, papan ketik, umpan balik, dan riset")


def f1():
    plan = table(
        ["Fase", "File yang berubah", "Tes", "Anggaran"],
        [
            ["1. Daftar baru (UI saja)", "TasksLiveNowSection.tsx ditulis ulang; live-now/LiveNowRow.tsx baru menggantikan LiveNowCard.tsx (dihapus, 438 baris); live-now/useLiveNowModel.ts baru (grup dan urutan, dipakai daftar dan pita); live-now-health.ts; story tasks-live-now", "TasksLiveNowSection.test.tsx: urutan grup, Needs attention tidak pernah tersembunyi, kerapatan tersimpan, Stop lewat More dengan konfirmasi; LiveNowTodoLine.test.tsx tetap", "Detik berjalan hanya di teks durasi: 0 render bagian per detik (sekarang seluruh bagian, useSecondTick:229); bundle naik paling banyak 3 kB gzip"],
            ["2. Pita kanban (UI saja)", "IssuesList.tsx (pita dirender di mode board); live-now/LiveNowBoardBand.tsx baru; KanbanBoard.tsx (penanda Paused dan Stalled)", "IssuesList.test.tsx: pita muncul di board, ikut filter, chip hidden by filters; KanbanBoard.test.tsx: penanda", "0 permintaan baru: live-runs sudah diambil halaman Issues di kedua mode (Issues.tsx:209)"],
            ["3a. Pause dan Resume (server + UI)", "validators/issue-tree-control.ts (scope, stopAt); migrasi kolom scope; services/issue-tree-control.ts (anggota menurut scope); route GET paused-tasks; openapi.ts; event live; issues.ts:7285 (komentar saat Paused); ui/src/api/issues.ts", "Cakupan task hanya menahan task itu (kontrol negatif: subtree menahan anak); paused-tasks menolak company lain dan menyunting data rahasia; komentar saat Paused tersimpan tanpa wake", "1 GET paused-tasks per buka halaman + 1 per event; query di bawah 5 ms untuk 100 hold (diukur dengan EXPLAIN ANALYZE)"],
            ["3b. Titik aman omp_local", "adapter-utils adapter-steer-registry (permintaan berhenti); omp-local rpc-session.ts dan execute.ts; run-control (batas 120 s lalu cancelRun)", "RPC tiruan: abort dikirim hanya setelah hasil tool dengan pendingToolCount 0; batas waktu jatuh ke cancel; sesi ditandai utuh", "Tidak ada polling baru; timer per run yang di-pause saja"],
            ["3c. Pengingat", "Job terjadwal yang ada + item inbox", "Hold 24 jam membuat satu item, tidak dobel", "1 query per putaran scheduler"],
        ],
        ["13%", "37%", "29%", "21%"],
    )
    risks = (
        '<ul class="b sm">'
        + "<li>Mengubah cakupan hold menyentuh tombol Pause work di detail task. Mitigasi: default tetap subtree; hanya LIVE NOW yang mengirim task.</li>"
        + "<li>Satu task dengan beberapa run: Pause menghentikan semua run task itu. Ditulis di tooltip tombol.</li>"
        + "<li>Run selain omp_local tidak punya titik aman: berhenti segera, sama dengan Pause work hari ini.</li>"
        + "<li>Lebih dari 50 run live terpotong oleh batas live-runs; tidak berubah dari sekarang, pita menulis 50+.</li>"
        + "<li>CI: tidak ada e2e baru; tambahan tes komponen dan server diperkirakan di bawah 20 s total, diukur dari pipeline PR.</li>"
        + "</ul>"
    )
    body = plan + '<div class="grid g2"><div><h3>Risiko</h3><div style="height:1mm"></div>%s</div><div><h3>Migrasi dari komponen lama</h3><div style="height:1mm"></div><ul class="b sm"><li>LiveNowCard.tsx dan form Steer di dalam kartu dihapus pada fase 1; Steer pindah ke LiveNowRow, satu komponen saja.</li><li>Nama ekspor TasksLiveNowSection dan data-slot tasks-live-now tetap, sehingga pemanggil di Issues.tsx:314 tidak berubah.</li><li>Kunci localStorage lipat tetap; kerapatan disimpan di kunci baru per company.</li><li>Tanpa feature flag dan tanpa dua tampilan berdampingan.</li></ul></div></div>' % risks
    return page(body, "F \u00b7 Rencana", "Fase, file, tes, anggaran kinerja, risiko")


def f2(qa):
    decisions = [
        ("Arti Pause = hold task + berhenti di titik aman (pilihan a).", "Hold, gerbang antrean, dan wake sudah ada; sesi omp hanya ditandai utuh tanpa tool berjalan (execute.ts:1257); batas tunggu 120 s.", "Fase 3a lalu 3b."),
        ("Pause dari LIVE NOW hanya menahan task itu; Pause subtree di menu More.", "Hold hari ini menahan seluruh subtree; ZHA-6241 berada di bawah 3 induk, pause pada induk akan ikut menahan anak yang sedang live.", "Kolom scope + migrasi di fase 3a."),
        ("Daftar berbentuk baris; nyaman default di desktop, padat default di ponsel.", "12 task: %s px nyaman dan %s px padat, sekarang 1142 px; ponsel %s px per baris padat, sekarang 262 px per kartu." % (m("ln-desktop-comfortable-12"), m("ln-desktop-compact-12"), m("pcompact")), "Fase 1."),
        ("Kanban memakai pita 3 lajur (C1), bukan swimlane.", "Swimlane mengisi 1 dari 5 kolom; pita %s px dengan 2 kartu per lajur." % m("band-desktop"), "Fase 2."),
        ("Pause dan Resume boleh bagi pengguna board dengan akses company (sama dengan Stop).", "Tidak mengubah batas izin yang ada; agen tetap lewat API.", "Tidak ada perubahan izin."),
        ("Komentar manusia saat Paused diterima dan menunggu Resume (sekarang 409).", "Permintaan Zhafron: komentar masuk antrean dan tidak membangunkan; 409 dibuktikan di instance uji.", "Ubah issues.ts:7285 di fase 3a."),
        ("Pengingat Paused di 24 jam dan 72 jam ke inbox, tanpa auto-resume.", "Paused tidak memakan token; auto-resume bisa menjalankan pekerjaan yang sengaja ditahan.", "Fase 3c."),
        ("Task percakapan tidak menampilkan Pause, hanya Stop.", "run-state.ts:1426-1428: run percakapan yang dibatalkan tidak menyimpan sesi, jadi Resume akan mulai dari nol.", "Kondisi di LiveNowRow fase 1."),
        ("Filter dan pencarian berlaku ke LIVE NOW, dengan chip hidden by filters.", "Sekarang pencarian menyembunyikan seluruh bagian (IssuesList.tsx:1876).", "Fase 1 dan 2."),
    ]
    dec_html = "".join('<div class="dec"><b class="k">%d</b><div><b>%s</b> <span class="tag rec">rekomendasi: setuju</span><br><span class="mute">Alasan: %s Bila setuju: %s</span></div></div>' % (i + 1, a, b, c) for i, (a, b, c) in enumerate(decisions))
    est = table(
        ["Pekerjaan", "Pembanding (jam run aktif, diukur)", "Perkiraan"],
        [
            ["Desain (dokumen ini)", "ZHA-5100 2,07; ZHA-4945 1,14; ZHA-3761 1,01", "1,0 sampai 2,1 jam"],
            ["Build fase 1 daftar", "ZHA-3919 2,59 (todo LIVE NOW); ZHA-6141 1,16", "1,2 sampai 2,6 jam"],
            ["Build fase 2 kanban", "sama dengan fase 1", "1,2 sampai 2,6 jam"],
            ["Build fase 3a server + UI", "ZHA-5431 3,45 (retry UI + server); ZHA-2689 1,51 (pause tertahan)", "1,5 sampai 3,5 jam"],
            ["Build fase 3b titik aman omp_local", "tidak ada pembanding", "tebakan: 2 sampai 4 jam"],
            ["Review per ronde (+1 ronde cadangan)", "ZHA-3922 1,13; ZHA-5437 1,87", "1,1 sampai 1,9 jam per ronde"],
            ["Rilis + pasang per rilis", "ZHA-6214 0,80; ZHA-6142 0,69; ZHA-6176 0,46", "0,5 sampai 0,8 jam"],
        ],
        ["30%", "45%", "25%"],
    )
    unproven = (
        '<ul class="b xs">'
        + "<li>Titik aman omp_local belum diprototipe: abort RPC setelah turn_end dan resume dari sesi itu belum dijalankan.</li>"
        + "<li>Hold pada run sungguhan tidak dijalankan di instance uji; run tiruan tanpa proses tetap running 10 s setelah hold.</li>"
        + "<li>Folder kerja proyek utuh setelah pembatalan: dibaca dari kode lease, belum dicek di disk.</li>"
        + "<li>Biaya token saat Resume (tulis cache) belum diukur.</li>"
        + "<li>Apakah run setelah Resume membaca komentar agen yang masuk saat Paused belum dijalankan.</li>"
        + "<li>Angka tinggi rancangan berasal dari mockup HTML, bukan komponen React.</li>"
        + "</ul>"
    )
    body = (
        '<div class="grid g2" style="flex:1">'
        + "<div><h3>Keputusan terbuka untuk Zhafron</h3><div style='height:1.5mm'></div>%s</div>" % dec_html
        + "<div><h3>Estimasi dari task yang sudah berjalan</h3><div style='height:1mm'></div>%s<div class='cap'>Jam = jumlah finishedAt dikurangi startedAt semua run issue (wardmoteListIssueRuns), 15 Nov 2026. Tidak termasuk menunggu persetujuan, antrean CI, dan uji terima Zhafron.</div><div style='height:2.5mm'></div><h3>Belum terbukti</h3><div style='height:1mm'></div>%s<div class='cap'>QA render PDF ini: %s</div></div>" % (est, unproven, qa)
        + "</div>"
    )
    return page(body, "F \u00b7 Keputusan", "Keputusan bernomor, estimasi, dan yang belum terbukti")
