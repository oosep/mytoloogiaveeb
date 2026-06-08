/* ===========================================================================
   Eesti Mütoloogiaveeb — app.js
   Kogu eesprogrammi loogika:
     - Hash-põhine SPA marsruuter (V1–V6)
     - Autentimise olek (JWT küpsis + /api/auth/me)
     - REST API päringud fetch abil
     - Mapbox GL JS + 1917. a kihelkondade GeoJSON
     - Otsing, filtreerimine, sorteerimine
     - Dünaamiline vorm (asukohad + allikaviited)
   =========================================================================== */

(() => {
  'use strict';

  // --- Konfiguratsioon ----------------------------------------------------
  // Mapboxi võti laetakse serverist (/api/config), mitte ei ole hardcoditud.
  // Nii saab koodi GitHubi üles laadida ilma saladusi paljastamata.
  let MAPBOX_TOKEN = '';
  const SFAAR_IKOONID = {
    'Mets': '🌲',
    'Vesi': '🌊',
    'Kodu': '🏚️',
    'Ilm': '🌬️',
    'Kivid ja koopad': '🪨',
    'Põrgu': '🔥',
    'Muud': '✶',
  };

  const SFAAR_COLORS = {
    'Mets': '#2e7d32',
    'Vesi': '#1565c0',
    'Kodu': '#e65100',
    'Ilm': '#388e3c',
    'Kivid ja koopad': '#5d4037',
    'Põrgu': '#6a1b9a',
    'Muud': '#37474f',
  };

  const SFAAR_SVG = {
    'Mets': '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="2" y="12" width="4" height="10" rx="1"/><rect x="10" y="5" width="4" height="17" rx="1"/><rect x="18" y="8" width="4" height="14" rx="1"/></svg>',
    'Vesi': '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2c-5.33 4.55-8 8.48-8 11.8 0 4.98 3.8 8.2 8 8.2s8-3.22 8-8.2c0-3.32-2.67-7.25-8-11.8z"/></svg>',
    'Kodu': '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>',
    'Ilm': '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M17 8C8 10 5.9 16.17 3.82 21.34L5.71 22l1-2.3A4.49 4.49 0 0 0 8 20C19 20 22 3 22 3c-1 2-8 2-8 2z"/></svg>',
    'Kivid ja koopad': '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="8" r="4"/><path d="M6 20v-2c0-3.31 2.69-6 6-6s6 2.69 6 6v2"/></svg>',
    'Põrgu': '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 22c4.97 0 9-4.03 9-9-5 0-9 4-9 9zm0 0c-4.97 0-9-4.03-9-9 5 0 9 4 9 9zm0-12c0-3-2-5.5-4-7 0 3 1 5 4 7zm0 0c0-3 2-5.5 4-7 0 3-1 5-4 7z"/></svg>',
    'Muud': '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
  };

  const MOUNTAIN_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="38" height="38"><path d="m3 20 5-8 4 5 3-4 6 7H3z"/><circle cx="17" cy="7" r="2" fill="currentColor" stroke="none" opacity=".4"/></svg>`;

  // --- Olek ----------------------------------------------------------------
  const state = {
    kasutaja: null,        // { id, kasutajanimi, email, roll }
    sfaarid: [],
    kihelkonnad: [],       // GeoJSON property NIMI loend
    geojson: null,
    map: null,
    mapInited: false,
    homeMap: null,
    lemmikIds: new Set(),
  };

  // --- Lühendid ------------------------------------------------------------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );

  // --- API abifunktsioon ---------------------------------------------------
  async function api(path, opts = {}) {
    const res = await fetch('/api' + path, {
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (_) { data = {}; }
    if (!res.ok) throw new Error(data.viga || 'Serveri viga (' + res.status + ')');
    return data;
  }

  // --- Toast teavitused ----------------------------------------------------
  function toast(sõnum, tüüp = '') {
    const wrap = $('#toast-wrap');
    const el = document.createElement('div');
    el.className = 'toast ' + tüüp;
    el.textContent = sõnum;
    wrap.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateY(16px)';
      el.style.transition = 'all .3s';
      setTimeout(() => el.remove(), 300);
    }, 3000);
  }

  // =========================================================================
  //  AUTENTIMINE
  // =========================================================================
  async function laeKasutaja() {
    try {
      const d = await api('/auth/me');
      state.kasutaja = d.kasutaja;
      await laeLemmikud();
    } catch (_) {
      state.kasutaja = null;
      state.lemmikIds = new Set();
    }
    renderNavAuth();
  }

  async function laeLemmikud() {
    if (!state.kasutaja) { state.lemmikIds = new Set(); return; }
    try {
      const d = await api('/lemmikud');
      state.lemmikIds = new Set(d.lemmikud.map((o) => o.id));
    } catch (_) { state.lemmikIds = new Set(); }
  }

  function renderNavAuth() {
    const el = $('#nav-auth');
    if (state.kasutaja) {
      el.innerHTML = `
        <div class="nav-user">
          <a href="#/profiil" data-nav class="uname">${esc(state.kasutaja.kasutajanimi)}</a>
          <span class="urole">${esc(state.kasutaja.roll)}</span>
          <button class="btn-link" id="logout-btn">Välju</button>
        </div>`;
      $('#logout-btn').addEventListener('click', logout);
    } else {
      el.innerHTML = `<button class="btn btn-primary" id="login-open">Logi sisse</button>`;
      $('#login-open').addEventListener('click', () => avaAuthModal('login'));
    }
    // Peida rollipõhised nav-lingid
    $$('[data-roll]').forEach((a) => {
      const lubatud = a.dataset.roll.split(',');
      a.style.display = state.kasutaja && lubatud.includes(state.kasutaja.roll) ? '' : 'none';
    });
  }

  async function logout() {
    try { await api('/auth/logout', { method: 'POST' }); } catch (_) {}
    state.kasutaja = null;
    state.lemmikIds = new Set();
    renderNavAuth();
    toast('Oled välja logitud.');
    location.hash = '#/';
  }

  // --- Auth modaal ---------------------------------------------------------
  function avaAuthModal(tab = 'login') {
    $('#auth-modal').hidden = false;
    vahetaAuthTab(tab);
    $('#auth-error').hidden = true;
  }
  function suljeAuthModal() { $('#auth-modal').hidden = true; }
  function vahetaAuthTab(tab) {
    $$('.auth-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
    $('#form-login').hidden = tab !== 'login';
    $('#form-register').hidden = tab !== 'register';
  }
  function authViga(sõnum) {
    const e = $('#auth-error');
    e.textContent = sõnum; e.hidden = false;
  }

  // =========================================================================
  //  ANDMETE LAADIMINE (sfäärid, geojson)
  // =========================================================================
  async function laeAlgandmed() {
    try {
      const s = await api('/sfaarid');
      state.sfaarid = s.sfaarid;
    } catch (_) {
      state.sfaarid = ['Mets', 'Vesi', 'Kodu', 'Ilm', 'Kivid ja koopad', 'Põrgu', 'Muud'];
    }
    try {
      const cfg = await api('/config');
      MAPBOX_TOKEN = cfg.mapboxToken || '';
    } catch (_) { /* kasutab tühja stringi, kaart näitab Mapboxi veateadet */ }
    try {
      const res = await fetch('kihelkond_1917.geojson');
      state.geojson = await res.json();
      const nimed = state.geojson.features
        .map((f) => f.properties.NIMI)
        .filter(Boolean);
      state.kihelkonnad = [...new Set(nimed)].sort((a, b) => a.localeCompare(b, 'et'));
    } catch (e) {
      console.error('GeoJSON laadimine ebaõnnestus', e);
    }
  }

  // =========================================================================
  //  V1 — AVALEHT
  // =========================================================================
  async function renderHome() {
    // Sfäärid sidebar
    const list = $('#sfaar-list');
    list.innerHTML = state.sfaarid.map((s) => `
      <div class="sfaar-item" data-sfaar="${esc(s)}">
        <div class="sfaar-item-icon" style="background:${SFAAR_COLORS[s] || '#555'}">
          ${SFAAR_SVG[s] || ''}
        </div>
        <span class="sfaar-item-name">${esc(s)}</span>
      </div>`).join('');
    $$('.sfaar-item', list).forEach((item) =>
      item.addEventListener('click', () => {
        location.hash = '#/olendid?sfaar=' + encodeURIComponent(item.dataset.sfaar);
      })
    );

    // Kaart
    initHomeMap();

    // Viimati lisatud olendid (kuni 5)
    const grid = $('#viimati-grid');
    try {
      const d = await api('/olendid');
      const valik = d.olendid.filter((o) => o.staatus === 'avaldatud').slice(0, 5);
      if (!valik.length) {
        grid.innerHTML = '<p class="empty-msg">Avaldatud olendeid pole veel.</p>';
        return;
      }
      grid.innerHTML = valik.map((o) => `
        <div class="viimati-card" data-id="${o.id}">
          <div class="viimati-card-img">
            ${o.pilt_url
              ? `<img src="${esc(o.pilt_url)}" alt="${esc(o.nimi)}" onerror="this.parentElement.innerHTML='${MOUNTAIN_SVG}'">`
              : MOUNTAIN_SVG}
          </div>
          <div class="viimati-card-body">
            <h3>${esc(o.nimi)}</h3>
            <p>${esc(o.sfaar)}</p>
          </div>
        </div>`).join('');
      $$('.viimati-card', grid).forEach((c) =>
        c.addEventListener('click', () => { location.hash = '#/olend/' + c.dataset.id; })
      );
    } catch (_) {
      grid.innerHTML = '<p class="empty-msg">Olendite laadimine ebaõnnestus.</p>';
    }
  }

  function kihelkondKeskpunkt(feat) {
    let x = 0, y = 0, n = 0;
    function addRing(ring) { ring.forEach(([lng, lat]) => { x += lng; y += lat; n++; }); }
    const geom = feat.geometry;
    if (geom.type === 'Polygon') geom.coordinates.forEach(addRing);
    else if (geom.type === 'MultiPolygon') geom.coordinates.forEach((p) => p.forEach(addRing));
    return n ? [x / n, y / n] : [25.0, 58.7];
  }

  function initHomeMap() {
    const el = document.getElementById('home-map');
    if (!el || !state.geojson || !MAPBOX_TOKEN) return;
    if (state.homeMap) { setTimeout(() => state.homeMap.resize(), 50); return; }

    mapboxgl.accessToken = MAPBOX_TOKEN;
    const map = new mapboxgl.Map({
      container: 'home-map',
      style: 'mapbox://styles/mapbox/light-v11',
      center: [25.0, 58.7],
      zoom: 6.2,
    });
    state.homeMap = map;

    map.on('load', async () => {
      map.resize();
      map.addSource('kih', { type: 'geojson', data: state.geojson });
      map.addLayer({
        id: 'kih-fill', type: 'fill', source: 'kih',
        paint: { 'fill-color': '#b8d8b0', 'fill-opacity': 0.55 },
      });
      map.addLayer({
        id: 'kih-line', type: 'line', source: 'kih',
        paint: { 'line-color': '#7aaa70', 'line-width': 0.6 },
      });
      try {
        const d = await api('/olendid');
        d.olendid
          .filter((o) => o.staatus === 'avaldatud' && o.asukohad && o.asukohad.length)
          .forEach((o) => {
            const feat = state.geojson.features.find((f) => f.properties.NIMI === o.asukohad[0].kihelkond);
            if (!feat) return;
            const center = kihelkondKeskpunkt(feat);
            new mapboxgl.Marker({ color: SFAAR_COLORS[o.sfaar] || '#555', scale: 0.85 })
              .setLngLat(center)
              .setPopup(new mapboxgl.Popup({ offset: 25, closeButton: false })
                .setHTML(`<strong>${esc(o.nimi)}</strong><br><small>${esc(o.sfaar)}</small>`))
              .addTo(map);
          });
      } catch (_) {}
    });
  }

  // --- Olendi kaardi HTML --------------------------------------------------
  function olendKaartHTML(o) {
    const pilt = o.pilt_url
      ? `<img src="${esc(o.pilt_url)}" alt="${esc(o.nimi)}" onerror="this.parentNode.innerHTML='<div class=\\'placeholder\\'>${SFAAR_IKOONID[o.sfaar] || '✶'}</div>'">`
      : `<div class="placeholder">${SFAAR_IKOONID[o.sfaar] || '✶'}</div>`;
    const tags = (o.asukohad || [])
      .slice(0, 2)
      .map((a) => `<span class="tag">${esc(a.kihelkond)}</span>`)
      .join('');
    return `
      <article class="olend-card" data-id="${o.id}">
        <div class="olend-card-img">${pilt}</div>
        <div class="olend-card-body">
          <h3>${esc(o.nimi)}</h3>
          <div class="olend-card-sfaar">${SFAAR_IKOONID[o.sfaar] || ''} ${esc(o.sfaar)}</div>
          <p class="olend-card-desc">${esc(o.kirjeldus)}</p>
          <div class="olend-card-tags">${tags}</div>
        </div>
      </article>`;
  }
  function seoOlendKaardid(root) {
    $$('.olend-card', root).forEach((c) =>
      c.addEventListener('click', () => { location.hash = '#/olend/' + c.dataset.id; })
    );
  }

  // =========================================================================
  //  V2 — OLENDITE NIMEKIRI
  // =========================================================================
  async function renderOlendid(params) {
    // Täida sfääri ja kihelkonna filtrid
    const sfaarSel = $('#f-sfaar');
    if (sfaarSel.options.length <= 1) {
      sfaarSel.innerHTML = '<option value="">Kõik sfäärid</option>' +
        state.sfaarid.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
    }
    const kihSel = $('#f-kihelkond');
    if (kihSel.options.length <= 1) {
      kihSel.innerHTML = '<option value="">Kõik kihelkonnad</option>' +
        state.kihelkonnad.map((k) => `<option value="${esc(k)}">${esc(k)}</option>`).join('');
    }

    // Eeltäida URL-i parameetritest
    if (params.sfaar) sfaarSel.value = params.sfaar;
    if (params.kihelkond) kihSel.value = params.kihelkond;
    if (params.otsing) $('#f-otsing').value = params.otsing;

    await laeOlendiNimekiri();
  }

  async function laeOlendiNimekiri() {
    const otsing = $('#f-otsing').value.trim();
    const sfaar = $('#f-sfaar').value;
    const kihelkond = $('#f-kihelkond').value;
    const sort = $('#f-sort').value;

    const q = new URLSearchParams();
    if (otsing) q.set('otsing', otsing);
    if (sfaar) q.set('sfaar', sfaar);
    if (kihelkond) q.set('kihelkond', kihelkond);

    const grid = $('#olend-grid');
    try {
      const d = await api('/olendid?' + q.toString());
      let olendid = d.olendid;
      if (sort === 'nimi-desc') olendid.sort((a, b) => b.nimi.localeCompare(a.nimi, 'et'));
      else if (sort === 'sfaar') olendid.sort((a, b) => a.sfaar.localeCompare(b.sfaar, 'et') || a.nimi.localeCompare(b.nimi, 'et'));
      else olendid.sort((a, b) => a.nimi.localeCompare(b.nimi, 'et'));

      $('#olendid-empty').hidden = olendid.length > 0;
      grid.innerHTML = olendid.map(olendKaartHTML).join('');
      seoOlendKaardid(grid);
    } catch (e) {
      grid.innerHTML = '';
      toast(e.message, 'err');
    }
  }

  // =========================================================================
  //  V3 — OLENDI DETAILVAADE
  // =========================================================================
  async function renderDetail(id) {
    const wrap = $('#detail-content');
    wrap.innerHTML = '<p class="empty-msg">Laen…</p>';
    let o;
    try {
      const d = await api('/olendid/' + id);
      o = d.olend;
    } catch (e) {
      wrap.innerHTML = `<p class="empty-msg">${esc(e.message)}</p>`;
      return;
    }

    const pilt = o.pilt_url
      ? `<div class="detail-img" id="detail-img"><img src="${esc(o.pilt_url)}" alt="${esc(o.nimi)}" onerror="this.parentNode.innerHTML='<div class=\\'placeholder\\'>${SFAAR_IKOONID[o.sfaar] || '✶'}</div>'"></div>`
      : `<div class="detail-img"><div class="placeholder">${SFAAR_IKOONID[o.sfaar] || '✶'}</div></div>`;

    const heli = o.heli_url
      ? `<div class="detail-block"><h3>Pärimuslugu (heli)</h3><audio class="audio-player" controls src="${esc(o.heli_url)}"></audio></div>`
      : '';

    const allikad = (o.allikad || []).length
      ? `<div class="detail-block"><h3>Allikad</h3><ul class="detail-sources">${o.allikad
          .map((a) => `<li>${a.url ? `<a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.viide)}</a>` : esc(a.viide)}</li>`)
          .join('')}</ul></div>`
      : '';

    const asukohad = (o.asukohad || []).length
      ? `<div class="detail-block"><h3>Asukohad</h3><div class="olend-card-tags">${o.asukohad
          .map((a) => `<span class="tag">${esc(a.kihelkond)}${a.maakond ? ' · ' + esc(a.maakond) : ''}</span>`)
          .join('')}</div><div class="detail-map" id="detail-map"></div></div>`
      : '';

    const onLemmik = state.lemmikIds.has(o.id);
    const favBtn = state.kasutaja
      ? `<button class="fav-btn ${onLemmik ? 'on' : ''}" id="fav-btn">${onLemmik ? '★ Lemmikutes' : '☆ Lisa lemmikuks'}</button>`
      : '';

    const muudaBtn =
      state.kasutaja && (state.kasutaja.roll === 'admin' || o.autor === state.kasutaja.kasutajanimi)
        ? `<a href="#/muuda/${o.id}" data-nav class="btn btn-ghost">Muuda</a>`
        : '';

    wrap.innerHTML = `
      <div class="detail">
        <div class="detail-hero">
          ${pilt}
          <div class="detail-meta">
            <h1>${esc(o.nimi)}</h1>
            <span class="detail-sfaar-badge">${SFAAR_IKOONID[o.sfaar] || ''} ${esc(o.sfaar)}</span>
            <div class="detail-actions">${favBtn}${muudaBtn}</div>
            <p class="detail-desc">${esc(o.kirjeldus) || '<em>Kirjeldus puudub.</em>'}</p>
          </div>
        </div>
        ${heli}
        ${asukohad}
        ${allikad}
        <div class="detail-block related-block" id="related-block" hidden>
          <h3>Sama sfääri olendid</h3>
          <div class="related-grid" id="related-grid"></div>
        </div>
      </div>`;

    // Lemmiku nupp
    if (state.kasutaja) {
      $('#fav-btn').addEventListener('click', async () => {
        const on = state.lemmikIds.has(o.id);
        try {
          if (on) { await api('/lemmikud/' + o.id, { method: 'DELETE' }); state.lemmikIds.delete(o.id); }
          else { await api('/lemmikud/' + o.id, { method: 'POST' }); state.lemmikIds.add(o.id); }
          renderDetail(id);
        } catch (e) { toast(e.message, 'err'); }
      });
    }

    // Pildi lightbox
    const di = $('#detail-img');
    if (di && o.pilt_url) {
      di.addEventListener('click', () => avaLightbox(o.pilt_url, o.nimi));
    }

    // Asukohakaart
    if ((o.asukohad || []).length) renderDetailMap(o);

    // Seotud olendid
    laeSeotud(o);
  }

  function renderDetailMap(o) {
    const el = $('#detail-map');
    if (!el || !state.geojson) return;
    mapboxgl.accessToken = MAPBOX_TOKEN;
    const m = new mapboxgl.Map({
      container: el,
      style: 'mapbox://styles/mapbox/streets-v12',
      center: [25.5, 58.7],
      zoom: 6.2,
      interactive: true,
    });
    const nimed = new Set(o.asukohad.map((a) => a.kihelkond));
    m.on('load', () => {
      m.addSource('kih', { type: 'geojson', data: state.geojson });
      m.addLayer({
        id: 'kih-fill', type: 'fill', source: 'kih',
        paint: {
          'fill-color': ['case', ['in', ['get', 'NIMI'], ['literal', [...nimed]]], '#8b4513', '#d4c5b0'],
          'fill-opacity': ['case', ['in', ['get', 'NIMI'], ['literal', [...nimed]]], 0.65, 0.15],
        },
      });
      m.addLayer({ id: 'kih-line', type: 'line', source: 'kih', paint: { 'line-color': '#4a2511', 'line-width': 0.6 } });
    });
  }

  async function laeSeotud(o) {
    try {
      const d = await api('/olendid?sfaar=' + encodeURIComponent(o.sfaar));
      const muud = d.olendid.filter((x) => x.id !== o.id && x.staatus === 'avaldatud').slice(0, 4);
      if (!muud.length) return;
      $('#related-block').hidden = false;
      const g = $('#related-grid');
      g.innerHTML = muud.map(olendKaartHTML).join('');
      seoOlendKaardid(g);
    } catch (_) {}
  }

  // --- Lightbox ------------------------------------------------------------
  function avaLightbox(src, alt) {
    $('#lightbox-img').src = src;
    $('#lightbox-img').alt = alt || '';
    $('#lightbox').hidden = false;
  }

  // =========================================================================
  //  KAART (täisvaade külgpaneeliga)
  // =========================================================================
  function initMap() {
    if (state.mapInited) { setTimeout(() => state.map.resize(), 100); return; }
    state.mapInited = true;
    mapboxgl.accessToken = MAPBOX_TOKEN;
    const map = new mapboxgl.Map({
      container: 'map',
      style: 'mapbox://styles/mapbox/streets-v12',
      center: [25.5, 58.6],
      zoom: 6.6,
    });
    state.map = map;
    let lukus = false;
    const panel = $('#map-panel');

    map.on('load', () => {
      map.resize();
      map.addSource('kihelkonnad', { type: 'geojson', data: state.geojson });

      // Taustavärv — mitte-Eesti / puuduvad andmed kuldkollasega
      map.addLayer({
        id: 'kihelkonnad-fill', type: 'fill', source: 'kihelkonnad',
        paint: {
          'fill-color': [
            'case',
            ['all',
              ['!=', ['get', 'KUBERMANG'], 'Eestimaa'],
              ['!=', ['get', 'KUBERMANG'], 'Liivimaa'],
            ], '#fbc02d',
            '#8b4513',
          ],
          'fill-opacity': 0.2,
        },
      });
      map.addLayer({
        id: 'kihelkonnad-outline', type: 'line', source: 'kihelkonnad',
        paint: { 'line-color': '#4a2511', 'line-width': 0.8 },
      });
      map.addLayer({
        id: 'kihelkonnad-labels', type: 'symbol', source: 'kihelkonnad',
        layout: {
          'text-field': ['get', 'NIMI'],
          'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
          'text-size': 10, 'text-transform': 'uppercase', 'text-letter-spacing': 0.08,
        },
        paint: { 'text-color': '#4a2511', 'text-halo-color': 'rgba(255,255,255,0.85)', 'text-halo-width': 1.2 },
      });

      const tõstaEsile = (nimi, op) =>
        map.setPaintProperty('kihelkonnad-fill', 'fill-opacity',
          ['case', ['==', ['get', 'NIMI'], nimi], op, 0.2]);

      map.on('mousemove', 'kihelkonnad-fill', (e) => {
        if (lukus || !e.features.length) return;
        map.getCanvas().style.cursor = 'pointer';
        tõstaEsile(e.features[0].properties.NIMI, 0.45);
      });
      map.on('mouseleave', 'kihelkonnad-fill', () => {
        if (lukus) return;
        map.getCanvas().style.cursor = '';
        map.setPaintProperty('kihelkonnad-fill', 'fill-opacity', 0.2);
      });

      map.on('click', 'kihelkonnad-fill', async (e) => {
        const p = e.features[0].properties;
        lukus = true;
        panel.classList.add('visible', 'locked');
        tõstaEsile(p.NIMI, 0.6);
        await näitaKihelkond(p);
        e.originalEvent.stopPropagation();
      });

      map.on('click', (e) => {
        const f = map.queryRenderedFeatures(e.point, { layers: ['kihelkonnad-fill'] });
        if (!f.length) suljeMapPanel();
      });
    });

    $('#map-panel-close').addEventListener('click', suljeMapPanel);

    function suljeMapPanel() {
      lukus = false;
      panel.classList.remove('visible', 'locked');
      if (map.getLayer('kihelkonnad-fill')) {
        map.setPaintProperty('kihelkonnad-fill', 'fill-opacity', 0.2);
      }
    }
  }

  async function näitaKihelkond(p) {
    $('#map-panel-default').hidden = true;
    $('#map-panel-detail').hidden = false;
    $('#mp-maakond').textContent = (p.MAAKOND || '') + ' maakond';
    $('#mp-nimi').textContent = p.NIMI + ' kihelkond';
    $('#mp-kubermang').textContent = '';

    const cont = $('#mp-olendid');
    cont.innerHTML = '<p style="color:var(--ink-soft)">Laen olendeid…</p>';
    try {
      const d = await api('/kihelkonnad/' + encodeURIComponent(p.NIMI) + '/olendid');
      if (!d.olendid.length) {
        cont.innerHTML = '<p style="color:var(--ink-soft);font-style:italic">Selle kihelkonnaga pole veel olendeid seotud.</p>';
        return;
      }
      cont.innerHTML = d.olendid.map((o) => `
        <div class="mp-olend" data-id="${o.id}">
          <div class="mp-olend-thumb">${o.pilt_url
            ? `<img src="${esc(o.pilt_url)}" style="width:100%;height:100%;object-fit:cover;border-radius:8px" onerror="this.replaceWith(document.createTextNode('${SFAAR_IKOONID[o.sfaar] || '✶'}'))">`
            : (SFAAR_IKOONID[o.sfaar] || '✶')}</div>
          <div>
            <h4>${esc(o.nimi)}</h4>
            <span>${esc(o.sfaar)}</span>
          </div>
        </div>`).join('');
      $$('.mp-olend', cont).forEach((el) =>
        el.addEventListener('click', () => { location.hash = '#/olend/' + el.dataset.id; })
      );
    } catch (e) {
      cont.innerHTML = `<p style="color:#b3261e">${esc(e.message)}</p>`;
    }
  }

  // =========================================================================
  //  V4 — ADMIN HALDUSVAADE
  // =========================================================================
  async function renderAdmin() {
    if (!state.kasutaja || state.kasutaja.roll !== 'admin') {
      location.hash = '#/';
      toast('Halduslaud on ainult administraatoritele.', 'err');
      return;
    }
    let olendid = [];
    try {
      const d = await api('/olendid');
      olendid = d.olendid;
    } catch (e) { toast(e.message, 'err'); }

    // Statistika
    const arv = (st) => olendid.filter((o) => o.staatus === st).length;
    $('#admin-stats').innerHTML = `
      <div class="stat-card"><div class="num">${olendid.length}</div><div class="lbl">Kokku</div></div>
      <div class="stat-card"><div class="num">${arv('avaldatud')}</div><div class="lbl">Avaldatud</div></div>
      <div class="stat-card"><div class="num">${arv('modereerimisel')}</div><div class="lbl">Modereerimisel</div></div>
      <div class="stat-card"><div class="num">${arv('mustand')}</div><div class="lbl">Mustand</div></div>`;

    const tbody = $('#admin-tbody');
    tbody.innerHTML = olendid.map((o) => `
      <tr data-id="${o.id}">
        <td><span class="olend-name">${esc(o.nimi)}</span></td>
        <td>${SFAAR_IKOONID[o.sfaar] || ''} ${esc(o.sfaar)}</td>
        <td>${esc(o.autor || '—')}</td>
        <td><span class="status-dot ${esc(o.staatus)}">${esc(o.staatus)}</span></td>
        <td>
          <div class="row-actions">
            <select class="staatus-sel">
              ${['avaldatud', 'modereerimisel', 'mustand']
                .map((s) => `<option value="${s}" ${s === o.staatus ? 'selected' : ''}>${s}</option>`).join('')}
            </select>
            <a href="#/muuda/${o.id}" data-nav class="icon-btn">Muuda</a>
            <button class="icon-btn danger del-btn">Kustuta</button>
          </div>
        </td>
      </tr>`).join('');

    $$('.staatus-sel', tbody).forEach((sel) =>
      sel.addEventListener('change', async (e) => {
        const id = e.target.closest('tr').dataset.id;
        try {
          await api('/olendid/' + id + '/staatus', { method: 'PATCH', body: { staatus: e.target.value } });
          toast('Staatus uuendatud.');
          renderAdmin();
        } catch (err) { toast(err.message, 'err'); }
      })
    );
    $$('.del-btn', tbody).forEach((btn) =>
      btn.addEventListener('click', async (e) => {
        const id = e.target.closest('tr').dataset.id;
        if (!confirm('Kas oled kindel, et soovid selle olendi kustutada?')) return;
        try {
          await api('/olendid/' + id, { method: 'DELETE' });
          toast('Olend kustutatud.');
          renderAdmin();
        } catch (err) { toast(err.message, 'err'); }
      })
    );
  }

  // =========================================================================
  //  V5 — KASUTAJA PROFIIL
  // =========================================================================
  async function renderProfiil() {
    if (!state.kasutaja) { avaAuthModal('login'); location.hash = '#/'; return; }
    const k = state.kasutaja;
    $('#profiil-card').innerHTML = `
      <div class="profiil-inner">
        <div class="profiil-avatar">${esc(k.kasutajanimi[0].toUpperCase())}</div>
        <div class="profiil-info">
          <h2>${esc(k.kasutajanimi)}</h2>
          <p>${esc(k.email || '')}</p>
          <p>Roll: <span class="urole">${esc(k.roll)}</span></p>
        </div>
      </div>`;

    const grid = $('#lemmik-grid');
    try {
      const d = await api('/lemmikud');
      $('#lemmik-empty').hidden = d.lemmikud.length > 0;
      grid.innerHTML = d.lemmikud.map(olendKaartHTML).join('');
      seoOlendKaardid(grid);
    } catch (e) {
      grid.innerHTML = '';
      toast(e.message, 'err');
    }
  }

  // =========================================================================
  //  V6 — SISU LISAMISE / MUUTMISE VORM
  // =========================================================================
  function asukohaReaHTML(val = {}) {
    const opts = state.kihelkonnad
      .map((k) => `<option value="${esc(k)}" ${k === val.kihelkond ? 'selected' : ''}>${esc(k)}</option>`)
      .join('');
    return `
      <div class="vorm-dynamic-row">
        <select class="dyn-kihelkond"><option value="">— Vali kihelkond —</option>${opts}</select>
        <button type="button" class="rm" title="Eemalda">&times;</button>
      </div>`;
  }
  function viiteReaHTML(val = {}) {
    return `
      <div class="vorm-dynamic-row">
        <input type="text" class="dyn-viide" placeholder="Allika nimetus" value="${esc(val.viide || '')}" />
        <input type="url" class="dyn-viide-url" placeholder="URL (valikuline)" value="${esc(val.url || '')}" />
        <button type="button" class="rm" title="Eemalda">&times;</button>
      </div>`;
  }
  function seoRmNupud() {
    $$('.vorm-dynamic-row .rm').forEach((b) => {
      b.onclick = () => b.closest('.vorm-dynamic-row').remove();
    });
  }

  async function renderVorm(muudaId) {
    if (!state.kasutaja || !['toimetaja', 'admin'].includes(state.kasutaja.roll)) {
      toast('Sisu lisamiseks logi sisse toimetaja või adminina.', 'err');
      location.hash = '#/'; return;
    }

    // Täida sfääri valik
    $('#vorm-sfaar').innerHTML = state.sfaarid.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');

    // Lähtesta
    $('#olend-vorm').reset();
    $('#vorm-id').value = '';
    $('#asukoht-list').innerHTML = '';
    $('#viide-list').innerHTML = '';
    $('#vorm-teade').textContent = '';
    $('#vorm-pealkiri').textContent = 'Lisa uus olend';

    if (muudaId) {
      try {
        const d = await api('/olendid/' + muudaId);
        const o = d.olend;
        $('#vorm-pealkiri').textContent = 'Muuda: ' + o.nimi;
        $('#vorm-id').value = o.id;
        $('#vorm-nimi').value = o.nimi;
        $('#vorm-sfaar').value = o.sfaar;
        $('#vorm-kirjeldus').value = o.kirjeldus || '';
        $('#vorm-pilt').value = o.pilt_url || '';
        $('#vorm-heli').value = o.heli_url || '';
        (o.asukohad || []).forEach((a) => $('#asukoht-list').insertAdjacentHTML('beforeend', asukohaReaHTML(a)));
        (o.allikad || []).forEach((s) => $('#viide-list').insertAdjacentHTML('beforeend', viiteReaHTML(s)));
        seoRmNupud();
      } catch (e) { toast(e.message, 'err'); }
    }
  }

  // =========================================================================
  //  MARSRUUTER
  // =========================================================================
  const vaated = {
    '': 'view-home',
    'olendid': 'view-olendid',
    'kaart': 'view-kaart',
    'olend': 'view-detail',
    'admin': 'view-admin',
    'profiil': 'view-profiil',
    'lisa': 'view-vorm',
    'muuda': 'view-vorm',
  };

  function parsiHash() {
    const raw = location.hash.replace(/^#\/?/, '');
    const [teeOsa, paramStr] = raw.split('?');
    const osad = teeOsa.split('/').filter(Boolean);
    const params = {};
    if (paramStr) new URLSearchParams(paramStr).forEach((v, k) => { params[k] = v; });
    return { baas: osad[0] || '', id: osad[1] || null, params };
  }

  async function router() {
    const { baas, id, params } = parsiHash();
    const viewId = vaated[baas] != null ? vaated[baas] : 'view-home';

    // Näita õiget vaadet
    $$('.view').forEach((v) => { v.hidden = v.id !== viewId; });

    // Aktiivne nav-link
    $$('.nav-links a[data-nav]').forEach((a) => {
      const h = a.getAttribute('href').replace('#/', '');
      a.classList.toggle('active', h === baas || (baas === '' && h === ''));
    });

    // Sulge mobiilimenüü
    $('#nav-links').classList.remove('open');
    window.scrollTo(0, 0);

    // Vaatepõhine renderdamine
    switch (baas) {
      case '': await renderHome(); break;
      case 'olendid': await renderOlendid(params); break;
      case 'kaart': initMap(); break;
      case 'olend': if (id) await renderDetail(id); break;
      case 'admin': await renderAdmin(); break;
      case 'profiil': await renderProfiil(); break;
      case 'lisa': await renderVorm(null); break;
      case 'muuda': await renderVorm(id); break;
      default: location.hash = '#/';
    }
  }

  // =========================================================================
  //  SÜNDMUSTE SIDUMINE
  // =========================================================================
  function seoSündmused() {
    // Mobiilimenüü
    $('#nav-toggle').addEventListener('click', () => $('#nav-links').classList.toggle('open'));

    // Tagasi-nupud
    document.addEventListener('click', (e) => {
      if (e.target.matches('[data-back]')) history.back();
    });

    // Auth modaal
    $$('[data-close-modal]').forEach((el) => el.addEventListener('click', suljeAuthModal));
    $$('.auth-tab').forEach((t) => t.addEventListener('click', () => vahetaAuthTab(t.dataset.tab)));

    $('#form-login').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const d = await api('/auth/login', {
          method: 'POST',
          body: {
            kasutajanimi: $('#login-kasutajanimi').value.trim(),
            parool: $('#login-parool').value,
          },
        });
        state.kasutaja = d.kasutaja;
        await laeLemmikud();
        renderNavAuth();
        suljeAuthModal();
        toast('Tere tulemast, ' + d.kasutaja.kasutajanimi + '!');
        router();
      } catch (err) { authViga(err.message); }
    });

    $('#form-register').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const d = await api('/auth/register', {
          method: 'POST',
          body: {
            kasutajanimi: $('#reg-kasutajanimi').value.trim(),
            email: $('#reg-email').value.trim(),
            parool: $('#reg-parool').value,
          },
        });
        state.kasutaja = d.kasutaja;
        await laeLemmikud();
        renderNavAuth();
        suljeAuthModal();
        toast('Konto loodud! Oled sisse logitud.');
        router();
      } catch (err) { authViga(err.message); }
    });

    // Lightbox sulgemine
    $('#lightbox-close').addEventListener('click', () => { $('#lightbox').hidden = true; });
    $('#lightbox').addEventListener('click', (e) => { if (e.target.id === 'lightbox') $('#lightbox').hidden = true; });

    // Navbar otsing
    $('#navbar-search').addEventListener('submit', (e) => {
      e.preventDefault();
      const q = $('#navbar-search-input').value.trim();
      location.hash = '#/olendid' + (q ? '?otsing=' + encodeURIComponent(q) : '');
    });

    // Otsing nav-link fookustab otsinguvälja
    $('#nav-otsing').addEventListener('click', (e) => {
      e.preventDefault();
      const inp = $('#navbar-search-input');
      if (inp) { inp.focus(); } else { location.hash = '#/olendid'; }
    });

    // Olendite filtrid (live)
    let timer;
    ['#f-otsing'].forEach((sel) =>
      $(sel).addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(laeOlendiNimekiri, 250); })
    );
    ['#f-sfaar', '#f-kihelkond', '#f-sort'].forEach((sel) =>
      $(sel).addEventListener('change', laeOlendiNimekiri)
    );

    // Vorm: dünaamilised read
    $('#lisa-asukoht').addEventListener('click', () => {
      $('#asukoht-list').insertAdjacentHTML('beforeend', asukohaReaHTML());
      seoRmNupud();
    });
    $('#lisa-viide').addEventListener('click', () => {
      $('#viide-list').insertAdjacentHTML('beforeend', viiteReaHTML());
      seoRmNupud();
    });

    // Vormi salvestamine
    $('#olend-vorm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const teade = $('#vorm-teade');
      teade.textContent = '';
      const id = $('#vorm-id').value;

      const asukohad = $$('#asukoht-list .dyn-kihelkond')
        .map((s) => s.value)
        .filter(Boolean)
        .map((kihelkond) => {
          const feat = (state.geojson?.features || []).find((f) => f.properties.NIMI === kihelkond);
          return { kihelkond, maakond: feat ? feat.properties.MAAKOND : null };
        });

      const allikad = $$('#viide-list .vorm-dynamic-row')
        .map((row) => ({
          viide: $('.dyn-viide', row).value.trim(),
          url: $('.dyn-viide-url', row).value.trim(),
        }))
        .filter((a) => a.viide);

      const keha = {
        nimi: $('#vorm-nimi').value.trim(),
        sfaar: $('#vorm-sfaar').value,
        kirjeldus: $('#vorm-kirjeldus').value.trim(),
        pilt_url: $('#vorm-pilt').value.trim(),
        heli_url: $('#vorm-heli').value.trim(),
        asukohad,
        allikad,
      };

      try {
        let d;
        if (id) d = await api('/olendid/' + id, { method: 'PUT', body: keha });
        else d = await api('/olendid', { method: 'POST', body: keha });
        teade.className = 'vorm-teade ok';
        teade.textContent = id ? 'Olend salvestatud!' : 'Olend lisatud! ' +
          (state.kasutaja.roll === 'admin' ? 'Avaldatud.' : 'Saadetud modereerimisele.');
        toast('Salvestatud.');
        setTimeout(() => { location.hash = '#/olend/' + d.olend.id; }, 700);
      } catch (err) {
        teade.className = 'vorm-teade err';
        teade.textContent = err.message;
      }
    });

    window.addEventListener('hashchange', router);
  }

  // =========================================================================
  //  KÄIVITAMINE
  // =========================================================================
  async function init() {
    seoSündmused();
    await laeAlgandmed();
    await laeKasutaja();
    if (!location.hash) location.hash = '#/';
    router();
  }

  init();
})();