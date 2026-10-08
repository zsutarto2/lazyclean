import { createHmac } from 'node:crypto';
import { mkdir, writeFile, rm, cp } from 'node:fs/promises';
import cfg from '../config.json' with { type: 'json' };

const E = process.env, API = 'https://api-sg.aliexpress.com/sync';
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- AliExpress Affiliate API (signed, US market, USD, EN) ----------
async function ali(method, extra) {
  const p = { app_key: E.ALI_APP_KEY, timestamp: Date.now(), sign_method: 'sha256', method,
    tracking_id: E.ALI_TRACKING_ID, ship_to_country: 'US', target_currency: 'USD', target_language: 'EN', ...extra };
  const base = Object.keys(p).sort().map(k => k + p[k]).join('');
  p.sign = createHmac('sha256', E.ALI_APP_SECRET).update(base).digest('hex').toUpperCase();
  const r = await (await fetch(API + '?' + new URLSearchParams(p))).json();
  const key = Object.keys(r).find(k => k.endsWith('_response'));
  const prods = r[key]?.resp_result?.result?.products?.product;
  if (!prods) console.warn(`[AliExpress ${method}] empty/error response:`, JSON.stringify(r).slice(0, 400));
  return prods || [];
}
const norm = (x, hot) => ({
  id: String(x.product_id), title: x.product_title.slice(0, 90), img: x.product_main_image_url,
  price: x.target_sale_price, was: x.target_original_price, rate: x.evaluate_rate,
  sold: Number(x.lastest_volume || 0), link: x.promotion_link, hot,
  slug: x.product_title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50).replace(/^-|-$/g, '') + '-' + x.product_id });

// ---------- Supabase cache (optional) ----------
async function sb(method, path, body, h = {}) {
  if (!E.SUPABASE_URL) return null;
  const r = await fetch(`${E.SUPABASE_URL}/rest/v1/${path}`, { method, body: body && JSON.stringify(body),
    headers: { apikey: E.SUPABASE_SERVICE_KEY, Authorization: 'Bearer ' + E.SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json', ...h } });
  return method === 'GET' ? r.json() : null;
}

// ---------- SEO article (Claude if key set, witty template otherwise) ----------
async function article(p) {
  const hit = await sb('GET', `articles?id=eq.${p.id}&select=data`);
  if (hit?.[0]) return hit[0].data;
  let a = {
    meta: `${p.title} review for US buyers: price, pros, cons and who it's actually for.`,
    h1: `${p.title}: Is It Worth Your Desk Space?`,
    intro: `You get home, the floor looks like a snack crime scene, and the couch has fur on it that you swear wasn't there this morning. This ${p.title.split(' ').slice(0, 6).join(' ')} costs $${p.price} right now, so let's see if it's worth the dock space.`,
    sections: [
      { h: 'What You Get', b: `A well-reviewed pick among ${cfg.niche}, rated ${p.rate || 'highly'} by buyers, with ${p.sold.toLocaleString()}+ recent orders.` },
      { h: 'Who Should Buy It', b: 'Anyone who works long hours, owns a pet that sheds like it has a grudge, or has quietly given up on vacuuming on weekends.' },
      { h: 'Who Should Skip It', b: 'If your place is mostly thick shag rugs and floor-level cables, a robot will have a rough time and so will you.' }],
    faq: [{ q: 'Does it ship to the US?', a: 'Yes, listings here are filtered for US shipping, and prices show in USD.' }, { q: 'Will it work with US outlets?', a: 'Check the plug type and voltage on the listing (US version or included adapter) before you order.' }] };
  const prompt = `Write a 600-word SEO review article for a US audience about this product: "${p.title}", $${p.price}, rating ${p.rate}. Niche: ${cfg.niche}. Reader: busy office worker in a US apartment. Cover suction, mopping, mapping/app, noise, pet hair, maintenance cost, plus AliExpress buying cautions (US plug/voltage, global version, warranty, return policy).
Voice: casual, witty, relatable to millennial/Gen-Z office workers. No cliches or generic ad slogans. Be honest, include real cons. Only state specs you can infer from the title; don't invent numbers.
Return ONLY JSON: {"meta":"<=155 chars","h1":"","intro":"","sections":[{"h":"","b":""}] (4-5 sections: what you get, pros, cons, who it's for, verdict),"faq":[{"q":"","a":""}] (3 items)}`;
  let ok = false;
  if (E.GEMINI_API_KEY) for (let t = 0; t < 3 && !ok; t++) try {
    await new Promise(r => setTimeout(r, 7000 * (t + 1))); // jeda agar aman dari rate limit tier gratis
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', {
      method: 'POST', headers: { 'x-goog-api-key': E.GEMINI_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 4000, thinkingConfig: { thinkingBudget: 0 } } }) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = JSON.parse((await res.json()).candidates[0].content.parts[0].text.replace(/```json|```/g, '').trim());
    if (!j.h1 || !j.sections?.length || !j.faq?.length) throw new Error('bad JSON shape');
    a = j; ok = true;
  } catch (e) { console.warn(`Gemini attempt ${t + 1} failed for ${p.id}: ${e.message}`); }
  if (ok) await sb('POST', 'articles', { id: p.id, data: a }, { Prefer: 'resolution=merge-duplicates' }); // template tidak di-cache
  return a;
}

// ---------- Templates ----------
const buy = p => `<a class="buy" href="${esc(p.link)}" target="_blank" rel="sponsored nofollow noopener">Buy on AliExpress</a>`;
const card = p => `<div class="card"><a href="/p/${p.slug}/"><img src="${esc(p.img)}" alt="${esc(p.title)}" loading="lazy" width="300" height="300">
<h3>${esc(p.title)}</h3></a><div class="row"><b>$${esc(p.price)}</b>${p.was && p.was !== p.price ? `<s>$${esc(p.was)}</s>` : ''}</div>${buy(p)}</div>`;
const page = (title, desc, path, body, ld = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(desc)}"><link rel="canonical" href="${cfg.domain}${path}">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><link rel="stylesheet" href="/style.css">${ld}</head>
<body><header><a href="/" class="logo">${esc(cfg.siteName)}</a></header><main>${body}</main>
<footer><p>Disclosure: we earn a commission from qualifying purchases via AliExpress affiliate links, at no extra cost to you. Prices and availability can change.</p><p>&copy; ${new Date().getFullYear()} ${esc(cfg.siteName)}</p></footer></body></html>`;

const css = `*{box-sizing:border-box}body{margin:0;font:16px/1.6 system-ui,sans-serif;color:#1c1c28;background:#fafaf7}
header{padding:16px 5%;border-bottom:1px solid #e5e5df;background:#fff}.logo{font-weight:800;font-size:22px;color:#ff4747;text-decoration:none}
main{max-width:1100px;margin:auto;padding:24px 5%}h1{line-height:1.2}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:18px}
.card{background:#fff;border:1px solid #e5e5df;border-radius:12px;padding:12px;display:flex;flex-direction:column}.card a{color:inherit;text-decoration:none}
.card img{width:100%;height:auto;border-radius:8px}.card h3{font-size:15px;margin:8px 0}.row{display:flex;gap:8px;align-items:baseline;margin-top:auto}.row s{color:#888;font-size:13px}
.buy{display:block;text-align:center;background:#ff4747;color:#fff!important;font-weight:700;padding:10px;border-radius:8px;margin-top:10px;text-decoration:none}
.hero{padding:28px 0}.badge{background:#ffe8a3;padding:2px 8px;border-radius:99px;font-size:13px;font-weight:700}
.prod{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.2fr);gap:28px}@media(max-width:700px){.prod{grid-template-columns:1fr}}
.prod img{width:100%;border-radius:12px}article h2{margin-top:32px}footer{padding:24px 5%;font-size:13px;color:#666;text-align:center}`;

// ---------- Build ----------
const seen = new Map();
for (const [i, kw] of cfg.keywords.entries()) {
  const q = { keywords: kw, page_size: cfg.perKeyword, sort: 'LAST_VOLUME_DESC', page_no: 1 };
  for (const x of await ali('aliexpress.affiliate.product.query', q)) if (!seen.has(x.product_id)) seen.set(x.product_id, norm(x, false));
  if (i < 3) for (const x of await ali('aliexpress.affiliate.hotproduct.query', { keywords: kw, page_size: 4 }))
    seen.set(x.product_id, { ...norm(x, true), ...(seen.get(x.product_id) && { hot: true }) });
}
const all = [...seen.values()].filter(p => p.link && p.img).slice(0, cfg.maxProducts);
if (!all.length) throw new Error('No products returned. See the [AliExpress ...] log lines above for the API error.');
const hot = all.filter(p => p.hot).sort((a, b) => b.sold - a.sold).slice(0, 6);

await rm('dist', { recursive: true, force: true });
await mkdir('dist/p', { recursive: true });
await writeFile('dist/style.css', css);

await writeFile('dist/index.html', page(`${cfg.siteName}: ${cfg.niche} that ship to the US`, cfg.tagline, '/',
  `<section class="hero"><h1>${esc(cfg.tagline)}</h1><p>Hand-picked ${esc(cfg.niche)} from brands across AliExpress, all shipping to the US and priced in USD.</p></section>
<h2>🔥 Trending in the US right now</h2><div class="grid">${hot.map(card).join('')}</div>
<h2>All picks</h2><div class="grid">${all.map(card).join('')}</div>`));

for (const p of all) {
  const a = await article(p);
  const ld = `<script type="application/ld+json">${JSON.stringify([
    { '@context': 'https://schema.org', '@type': 'Product', name: p.title, image: p.img,
      offers: { '@type': 'Offer', priceCurrency: 'USD', price: p.price, url: p.link, availability: 'https://schema.org/InStock' } },
    { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: a.faq.map(f => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) }])}</script>`;
  await mkdir(`dist/p/${p.slug}`, { recursive: true });
  await writeFile(`dist/p/${p.slug}/index.html`, page(a.h1, a.meta, `/p/${p.slug}/`,
    `<div class="prod"><div><img src="${esc(p.img)}" alt="${esc(p.title)}"></div><div><h1>${esc(a.h1)}</h1>
<p>${p.hot ? '<span class="badge">🔥 Hot in the US</span> ' : ''}<b style="font-size:24px">$${esc(p.price)}</b> ${p.rate ? `· ${esc(p.rate)} positive` : ''}</p>${buy(p)}</div></div>
<article><p>${esc(a.intro)}</p>${a.sections.map(s => `<h2>${esc(s.h)}</h2><p>${esc(s.b)}</p>`).join('')}
<h2>FAQ</h2>${a.faq.map(f => `<h3>${esc(f.q)}</h3><p>${esc(f.a)}</p>`).join('')}${buy(p)}</article>`, ld));
}
await writeFile('dist/sitemap.xml', `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${cfg.domain}/</loc></url>${all.map(p => `<url><loc>${cfg.domain}/p/${p.slug}/</loc></url>`).join('')}</urlset>`);
await writeFile('dist/robots.txt', `User-agent: *\nAllow: /\nSitemap: ${cfg.domain}/sitemap.xml\n`);
console.log(`Built ${all.length} product pages.`);
