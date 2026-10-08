# Setup (Indonesia)

1. **Supabase**: buat project, jalankan `supabase.sql` di SQL Editor. Ambil Project URL + service_role key.
2. **GitHub**: push folder ini ke repo baru (1 repo = 1 minisite/niche).
3. **Cloudflare Pages** → Connect to Git → pilih repo.
   - Build command: `node scripts/build.mjs`
   - Output directory: `dist`
   - Environment variables (Secret):
     `ALI_APP_KEY`, `ALI_APP_SECRET`, `ALI_TRACKING_ID`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `GEMINI_API_KEY` (opsional, tanpa ini artikel pakai template singkat)
4. Ganti `config.json` (nama situs, domain, keyword per niche). Untuk niche baru: duplikat repo, ubah config saja.
5. Harga/produk update otomatis: Cloudflare Pages → Settings → Builds → Deploy hook, panggil tiap hari via cron (mis. GitHub Actions `curl -X POST <hook>`).
6. Submit `/sitemap.xml` ke Google Search Console.

Catatan: API key & secret JANGAN ditaruh di file frontend; hanya dipakai saat build.
Artikel di-cache di Supabase, jadi tiap rebuild tidak memanggil LLM ulang.

Catatan Gemini: hanya artikel hasil AI yang di-cache. Jika build kena rate limit, rebuild beberapa jam kemudian; sisa artikel akan terisi otomatis.
