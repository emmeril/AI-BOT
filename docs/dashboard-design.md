# Arah desain dashboard

Arahan pemilik: UI harus sederhana dan mudah dipahami oleh orang awam.

Design Read: dashboard trading live untuk pengguna nonteknis, dengan bahasa visual tenang, jelas, dan berorientasi keputusan. Dials: ENERGY 1, RHYTHM 2, MOTION 1.

## Alasan keputusan utama

- Warna: hijau menandai kondisi aktif atau aman, jingga menandai SHORT dan kondisi menunggu, sedangkan merah hanya dipakai saat ada masalah nyata.
- Tema: latar gelap dipertahankan karena dashboard dipantau terus-menerus dan tema ini mengurangi silau; semua pasangan warna tetap memenuhi kontras WCAG AA.
- Tata letak: layar utama hanya memuat kondisi bot, pembagian modal, dan keputusan pair terpilih. Informasi LONG dan SHORT yang berulang dihapus karena status keduanya sudah terlihat pada ringkasan kondisi.
- Tipografi: Segoe UI memakai font bawaan sistem yang akrab dan mudah dibaca; monospace dibatasi untuk angka agar nilai sejajar saat berubah.
- Jarak: ruang lebih besar memisahkan keputusan utama, sedangkan detail teknis memakai jarak lebih rapat agar tidak mengambil fokus.
- Panel: pembagian per pair, leverage, Fibonacci, grafik, risiko, dan order ditempatkan dalam satu disclosure “Lihat rincian” agar layar utama tetap sederhana.
- Ikon: hanya ikon refresh yang dipakai karena fungsinya langsung dikenali; status lain selalu dijelaskan dengan teks, bukan warna atau ikon saja.
- Gerak: animasi hanya dipakai untuk proses loading dan refresh sebagai umpan balik, serta dapat dimatikan oleh pengguna.
