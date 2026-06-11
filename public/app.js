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

  // Sfääride värvid — maalähedane rahvapärane palett, mis sobitub
  // veebi rohelis-pruuni disainiga, kuid hoiab sfäärid kaardil eristatavad.
  const SFAAR_COLORS = {
    'Mets': '#2e6b34',
    'Vesi': '#22657e',
    'Kodu': '#b3661e',
    'Ilm': '#7c9a5a',
    'Kivid ja koopad': '#5d4631',
    'Põrgu': '#8a2f1d',
    'Muud': '#4a5548',
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
    homeKaart: null,       // jagatud kaardi-instants (avaleht)
    suurKaart: null,       // jagatud kaardi-instants (kaardileht)
    sfaarFilter: new Set(),// avalehe sfäärifilter: tühi = näita kõiki
    olendidCache: null,    // /api/olendid vahemälu kaartide markerite jaoks
    lemmikIds: new Set(),
  };

  // --- Lühendid ------------------------------------------------------------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  // Lubab linkides AINULT http(s) ja suhtelisi URL-e — javascript: jms ei pääse läbi
  const turvalineUrl = (u) => {
    try {
      const p = new URL(String(u), location.origin).protocol;
      return p === 'https:' || p === 'http:' ? String(u) : null;
    } catch (_) { return null; }
  };

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
    state.olendidCache = null; // roll muutus -> /api/olendid vastus muutub
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
      state.turnstileSiteKey = cfg.turnstileSiteKey || '';
      // Sea CAPTCHA widgeti sitekey, kui see on serveris seadistatud
      const tEl = document.getElementById('reg-turnstile');
      if (tEl && state.turnstileSiteKey) {
        tEl.setAttribute('data-sitekey', state.turnstileSiteKey);
      }
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
    // Sfäärid külgpaneelis = kaardi MARKERITE FILTRID.
    // (Varem viis klõps olendite nimekirja — nüüd lülitab sfääri
    //  kaardil sisse/välja. Tühi valik tähendab "näita kõiki".)
    const list = $('#sfaar-list');
    if (!list) return;
    list.innerHTML = state.sfaarid.map((s) => `
      <button type="button" class="sfaar-item ${state.sfaarFilter.has(s) ? 'active' : ''}"
              data-sfaar="${esc(s)}" aria-pressed="${state.sfaarFilter.has(s)}">
        <span class="sfaar-item-icon" style="--sf-color:${SFAAR_COLORS[s] || '#555'}">
          ${SFAAR_SVG[s] || ''}
        </span>
        <span class="sfaar-item-name">${esc(s)}</span>
        <span class="sfaar-item-check" aria-hidden="true">✦</span>
      </button>`).join('');
    $$('.sfaar-item', list).forEach((item) =>
      item.addEventListener('click', () => {
        const sf = item.dataset.sfaar;
        if (state.sfaarFilter.has(sf)) state.sfaarFilter.delete(sf);
        else state.sfaarFilter.add(sf);
        item.classList.toggle('active', state.sfaarFilter.has(sf));
        item.setAttribute('aria-pressed', state.sfaarFilter.has(sf));
        rakendaSfaarFilter();
      })
    );

    // Kaart — TÄPSELT sama kaart mis kaardilehel (üks jagatud ehitaja)
    if (state.homeKaart) state.homeKaart.resize();
    else state.homeKaart = looKihelkonnaKaart({ container: 'home-map', panel: homePaneel() });
    rakendaSfaarFilter();

    // Viimati lisatud olendid (kuni 5)
    const grid = $('#viimati-grid');
    try {
      const olendid = await laeOlendidCache();
      const valik = olendid.filter((o) => o.staatus === 'avaldatud').slice(0, 5);
      if (!valik.length) {
        grid.innerHTML = '<p class="empty-msg">Avaldatud olendeid pole veel.</p>';
        return;
      }
      grid.innerHTML = valik.map((o) => `
        <div class="viimati-card" data-id="${o.id}">
          <div class="viimati-card-img">
            ${o.pilt_url
              ? `<img src="${esc(o.pilt_url)}" alt="${esc(o.nimi)}" data-fallback="mountain">`
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

  // =========================================================================
  //  JAGATUD KIHELKONNAKAART
  //  -------------------------------------------------------------------
  //  KOODIKVALITEET: varem oli kaks ~80% kattuvat funktsiooni
  //  (initHomeMap + initMap), mis joonistasid ERINEVAD kaardid.
  //  Nüüd on ÜKS ehitaja, mida kasutavad nii avaleht kui kaardileht —
  //  mõlemad saavad garanteeritult samasuguse kaardi: kihelkondade
  //  täidted, sildid, hover-esiletõste, klõpsatav külgpaneel JA
  //  sfäärivärvilised olendimarkerid.
  // =========================================================================
  function looKihelkonnaKaart(opts) {
    const el = document.getElementById(opts.container);
    if (!el) return null;
    if (!MAPBOX_TOKEN || !state.geojson) {
      el.innerHTML = '<div class="map-missing">Kaart pole saadaval</div>';
      return null;
    }

    mapboxgl.accessToken = MAPBOX_TOKEN;
    const map = new mapboxgl.Map({
      container: opts.container,
      style: 'mapbox://styles/mapbox/streets-v12',
      center: [25.3, 58.65],
      zoom: 6.3,
    });

    const panel = opts.panel;
    let lukus = false;
    const markerid = []; // { marker, sfaar } — sfäärifiltri jaoks

    const tõstaEsile = (nimi, op) =>
      map.setPaintProperty('kih-fill', 'fill-opacity',
        ['case', ['==', ['get', 'NIMI'], nimi], op, 0.22]);

    function suljePaneel() {
      lukus = false;
      panel.root.classList.remove('visible', 'locked');
      if (map.getLayer('kih-fill')) {
        map.setPaintProperty('kih-fill', 'fill-opacity', 0.22);
      }
    }

    map.on('load', async () => {
      map.resize();
      map.addSource('kih', { type: 'geojson', data: state.geojson });

      // Ajaloolised Eesti- ja Liivimaa kihelkonnad sügava metsapruuniga,
      // muud alad kuldse "vana atlase" tooniga.
      map.addLayer({
        id: 'kih-fill', type: 'fill', source: 'kih',
        paint: {
          'fill-color': [
            'case',
            ['all',
              ['!=', ['get', 'KUBERMANG'], 'Eestimaa'],
              ['!=', ['get', 'KUBERMANG'], 'Liivimaa'],
            ], '#c9a227',
            '#5b4322',
          ],
          'fill-opacity': 0.22,
        },
      });
      map.addLayer({
        id: 'kih-line', type: 'line', source: 'kih',
        paint: { 'line-color': '#3a2a12', 'line-width': 0.8 },
      });
      map.addLayer({
        id: 'kih-labels', type: 'symbol', source: 'kih',
        layout: {
          'text-field': ['get', 'NIMI'],
          'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
          'text-size': 10, 'text-transform': 'uppercase', 'text-letter-spacing': 0.08,
        },
        paint: { 'text-color': '#3a2a12', 'text-halo-color': 'rgba(250,246,239,0.85)', 'text-halo-width': 1.2 },
      });

      // Hover-esiletõste
      map.on('mousemove', 'kih-fill', (e) => {
        if (lukus || !e.features.length) return;
        map.getCanvas().style.cursor = 'pointer';
        tõstaEsile(e.features[0].properties.NIMI, 0.5);
      });
      map.on('mouseleave', 'kih-fill', () => {
        if (lukus) return;
        map.getCanvas().style.cursor = '';
        map.setPaintProperty('kih-fill', 'fill-opacity', 0.22);
      });

      // Klõps kihelkonnal → külgpaneel seotud olenditega
      map.on('click', 'kih-fill', async (e) => {
        const p = e.features[0].properties;
        lukus = true;
        panel.root.classList.add('visible', 'locked');
        tõstaEsile(p.NIMI, 0.62);
        await näitaKihelkond(p, panel);
        e.originalEvent.stopPropagation();
      });
      map.on('click', (e) => {
        const f = map.queryRenderedFeatures(e.point, { layers: ['kih-fill'] });
        if (!f.length) suljePaneel();
      });

      // Olendimarkerid sfääri värviga — samad mõlemal kaardil
      try {
        const olendid = await laeOlendidCache();
        olendid
          .filter((o) => o.staatus === 'avaldatud' && o.asukohad && o.asukohad.length)
          .forEach((o) => {
            const feat = state.geojson.features.find((f) => f.properties.NIMI === o.asukohad[0].kihelkond);
            if (!feat) return;
            const marker = new mapboxgl.Marker({ color: SFAAR_COLORS[o.sfaar] || '#555', scale: 0.85 })
              .setLngLat(kihelkondKeskpunkt(feat))
              .setPopup(new mapboxgl.Popup({ offset: 25, closeButton: false })
                .setHTML(
                  `<strong>${esc(o.nimi)}</strong><br><small>${esc(o.sfaar)}</small>` +
                  `<br><a href="#/olend/${Number(o.id)}">Vaata olendit →</a>`
                ))
              .addTo(map);
            markerid.push({ marker, sfaar: o.sfaar });
          });
      } catch (_) { /* markerite puudumine ei riku kaarti */ }
    });

    panel.closeBtn.addEventListener('click', suljePaneel);

    return {
      map,
      resize: () => setTimeout(() => map.resize(), 60),
      /** Sfäärifilter: tühi Set või null = näita kõiki markereid. */
      setSfaarFilter(valik) {
        markerid.forEach(({ marker, sfaar }) => {
          const näita = !valik || valik.size === 0 || valik.has(sfaar);
          marker.getElement().style.display = näita ? '' : 'none';
        });
      },
    };
  }

  /** Külgpaneelide elemendiviited — avaleht ja kaardileht omavad kumbki oma paneeli. */
  const homePaneel = () => ({
    root: $('#home-panel'), closeBtn: $('#home-panel-close'),
    def: $('#home-panel-default'), det: $('#home-panel-detail'),
    maakond: $('#hp-maakond'), nimi: $('#hp-nimi'), olendid: $('#hp-olendid'),
  });
  const kaartPaneel = () => ({
    root: $('#map-panel'), closeBtn: $('#map-panel-close'),
    def: $('#map-panel-default'), det: $('#map-panel-detail'),
    maakond: $('#mp-maakond'), nimi: $('#mp-nimi'), olendid: $('#mp-olendid'),
  });

  /** Rakendab avalehe sfäärifiltri kaardile ja uuendab "Tühjenda" nuppu. */
  function rakendaSfaarFilter() {
    if (state.homeKaart) state.homeKaart.setSfaarFilter(state.sfaarFilter);
    const reset = $('#sfaar-reset');
    if (reset) reset.hidden = state.sfaarFilter.size === 0;
  }

  /**
   * /api/olendid vahemälu: avaleht, mõlemad kaardid ja "viimati lisatud"
   * jagavad üht vastust, selle asemel et sama päringut korrata.
   * Vahemälu nullitakse sisu muutmisel ja sisse-/väljalogimisel.
   */
  async function laeOlendidCache() {
    if (state.olendidCache) return state.olendidCache;
    const d = await api('/olendid');
    state.olendidCache = d.olendid;
    return state.olendidCache;
  }

  // --- Olendi kaardi HTML --------------------------------------------------
  function olendKaartHTML(o) {
    // TURVAPARANDUS: pildi varuvariant inline onerror-atribuudi asemel
    // data-fallback atribuudiga (vt delegeeritud käsitlejat init()-is).
    // See lubas CSP-st 'unsafe-inline' eemaldada — süstitud HTML-i
    // sees olevad on*-atribuudid enam EI käivitu.
    const pilt = o.pilt_url
      ? `<img src="${esc(o.pilt_url)}" alt="${esc(o.nimi)}" data-fallback="${esc(SFAAR_IKOONID[o.sfaar] || '✶')}">`
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
      ? `<div class="detail-img" id="detail-img"><img src="${esc(o.pilt_url)}" alt="${esc(o.nimi)}" data-fallback="${esc(SFAAR_IKOONID[o.sfaar] || '✶')}"></div>`
      : `<div class="detail-img"><div class="placeholder">${SFAAR_IKOONID[o.sfaar] || '✶'}</div></div>`;

    const heli = o.heli_url
      ? `<div class="detail-block"><h3>Pärimuslugu (heli)</h3><audio class="audio-player" controls src="${esc(o.heli_url)}"></audio></div>`
      : '';

    const allikad = (o.allikad || []).length
      ? `<div class="detail-block"><h3>Allikad</h3><ul class="detail-sources">${o.allikad
          .map((a) => {
            const url = a.url && turvalineUrl(a.url); // XSS-kaitse: ainult http(s) lingid
            return `<li>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(a.viide)}</a>` : esc(a.viide)}</li>`;
          })
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
          'fill-color': ['case', ['in', ['get', 'NIMI'], ['literal', [...nimed]]], '#5b4322', '#d8ccb4'],
          'fill-opacity': ['case', ['in', ['get', 'NIMI'], ['literal', [...nimed]]], 0.65, 0.15],
        },
      });
      m.addLayer({ id: 'kih-line', type: 'line', source: 'kih', paint: { 'line-color': '#3a2a12', 'line-width': 0.6 } });
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

  async function näitaKihelkond(p, panel) {
    panel.def.hidden = true;
    panel.det.hidden = false;
    panel.maakond.textContent = (p.MAAKOND || '') + ' maakond';
    panel.nimi.textContent = p.NIMI + ' kihelkond';

    const cont = panel.olendid;
    cont.innerHTML = '<p class="mp-laen">Laen olendeid…</p>';
    try {
      const d = await api('/kihelkonnad/' + encodeURIComponent(p.NIMI) + '/olendid');
      if (!d.olendid.length) {
        cont.innerHTML = '<p class="mp-tühi">Selle kihelkonnaga pole veel olendeid seotud.</p>';
        return;
      }
      cont.innerHTML = d.olendid.map((o) => `
        <div class="mp-olend" data-id="${Number(o.id)}">
          <div class="mp-olend-thumb">${o.pilt_url
            ? `<img src="${esc(o.pilt_url)}" alt="" data-fallback="${esc(SFAAR_IKOONID[o.sfaar] || '✶')}">`
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
      cont.innerHTML = `<p class="mp-viga">${esc(e.message)}</p>`;
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
          state.olendidCache = null;
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
          state.olendidCache = null;
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
    $('#vorm-pilt').value = '';
    $('#vorm-heli').value = '';
    näitaOlemasolevManus('pilt', null);
    näitaOlemasolevManus('heli', null);
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
        näitaOlemasolevManus('pilt', o.pilt_url);
        näitaOlemasolevManus('heli', o.heli_url);
        (o.asukohad || []).forEach((a) => $('#asukoht-list').insertAdjacentHTML('beforeend', asukohaReaHTML(a)));
        (o.allikad || []).forEach((s) => $('#viide-list').insertAdjacentHTML('beforeend', viiteReaHTML(s)));
        seoRmNupud();
      } catch (e) { toast(e.message, 'err'); }
    }
  }

  // --- Failide üleslaadimine (turvaline API /api/failid) --------------------
  // NB: siin EI kasutata api() abifunktsiooni, sest FormData puhul peab brauser
  // ise multipart Content-Type'i (koos boundary'ga) seadma.
  async function laeFailYles(fail, liik) {
    const fd = new FormData();
    fd.append('liik', liik);
    fd.append('fail', fail, fail.name);
    const res = await fetch('/api/failid', { method: 'POST', body: fd, credentials: 'same-origin' });
    let data = {};
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) throw new Error(data.viga || 'Üleslaadimine ebaõnnestus (' + res.status + ')');
    return data.fail;
  }

  /** Kuvab manuse infoploki koos "Eemalda" nupuga (DOM API, mitte innerHTML). */
  function näitaManusInfo(liik, tekst) {
    const info = $('#vorm-' + liik + '-info');
    info.hidden = false;
    info.textContent = '';
    const span = document.createElement('span');
    span.textContent = tekst;
    const eemalda = document.createElement('button');
    eemalda.type = 'button';
    eemalda.className = 'btn-small';
    eemalda.textContent = 'Eemalda';
    eemalda.addEventListener('click', () => {
      $('#vorm-' + liik).value = '';
      $('#vorm-' + liik + '-fail').value = '';
      info.hidden = true;
      info.textContent = '';
    });
    info.append(span, ' ', eemalda);
  }

  function näitaOlemasolevManus(liik, url) {
    const info = $('#vorm-' + liik + '-info');
    info.hidden = true;
    info.textContent = '';
    if (url) näitaManusInfo(liik, liik === 'pilt' ? '✓ Pilt on salvestatud.' : '✓ Helifail on salvestatud.');
  }

  /** Seob failisisendi: valikul laaditakse fail kohe üles ja viide salvub peitväljale. */
  function seoFailiSisend(liik) {
    const sisend = $('#vorm-' + liik + '-fail');
    const info = $('#vorm-' + liik + '-info');
    const maxMB = liik === 'pilt' ? 5 : 20;
    sisend.addEventListener('change', async () => {
      const fail = sisend.files && sisend.files[0];
      if (!fail) return;
      if (fail.size > maxMB * 1024 * 1024) {
        toast('Fail on liiga suur (max ' + maxMB + ' MB).', 'err');
        sisend.value = '';
        return;
      }
      info.hidden = false;
      info.textContent = 'Laen üles: ' + fail.name + '…';
      sisend.disabled = true;
      try {
        const f = await laeFailYles(fail, liik);
        $('#vorm-' + liik).value = f.url;
        näitaManusInfo(liik, '✓ ' + f.originaalnimi + ' (' + Math.max(1, Math.round(f.suurus / 1024)) + ' kB)');
        toast('Fail üles laaditud.');
      } catch (e) {
        info.hidden = true;
        info.textContent = '';
        sisend.value = '';
        toast(e.message, 'err');
      } finally {
        sisend.disabled = false;
      }
    });
  }

  // =========================================================================
  //  V7 / V8 — JURIIDILISED LEHED (privaatsuspoliitika, kasutustingimused)
  // =========================================================================
  const LEGAL_UPDATED = '10.06.2026';

  const LEGAL_SISU = {
    privaatsus: `
      <p class="legal-meta">Viimati uuendatud: ${LEGAL_UPDATED}</p>

      <p>Käesolev privaatsuspoliitika selgitab, kuidas Eesti Mütoloogiaveeb
      (edaspidi „veeb") kogub, kasutab ja kaitseb sinu isikuandmeid kooskõlas
      Euroopa Liidu isikuandmete kaitse üldmäärusega (GDPR) ja Eesti
      isikuandmete kaitse seadusega.</p>

      <h2>1. Vastutav töötleja</h2>
      <p>Veebi haldab Tallinna Ülikooli õppeprojekti meeskond hariduslikul
      eesmärgil. Andmekaitse küsimustes saab ühendust võtta aadressil
      <a href="mailto:privaatsus@mytoloogia.ee">privaatsus@mytoloogia.ee</a>.</p>

      <h2>2. Milliseid andmeid kogutakse</h2>
      <ul>
        <li><b>Konto andmed:</b> kasutajanimi, e-posti aadress ja paroolist
        loodud krüptograafiline räsi (parooli ennast ei säilitata kunagi avatekstina).</li>
        <li><b>Sisu:</b> sinu lisatud mütoloogiakirjed, lemmikud ja kommentaarid.</li>
        <li><b>Tehnilised logid:</b> IP-aadress ja toimingute aeg turvalisuse
        tagamiseks (brute-force-kaitse, auditijälg). Logisid säilitatakse piiratud aja.</li>
      </ul>

      <h2>3. Andmetöötluse õiguslik alus</h2>
      <p>Konto loomine ja sisu haldamine põhineb sinu <b>nõusolekul</b> (GDPR art 6 lg 1 p a)
      ning teenuse osutamise <b>lepingul</b> (p b). Turvalogide töötlemine põhineb veebi
      <b>õigustatud huvil</b> (p f) kaitsta süsteemi väärkasutuse eest.</p>

      <h2>4. Küpsised</h2>
      <p>Veeb kasutab ühte tehniliselt vajalikku küpsist (<code>token</code>)
      sisselogitud sessiooni hoidmiseks. See on <code>httpOnly</code> ja
      <code>SameSite=Strict</code>, ei sisalda jälgimisandmeid ega lähe
      kolmandatele osapooltele. Keelevalik salvestatakse samuti küpsisesse.
      Turundus- ega analüütikaküpsiseid ei kasutata.</p>

      <h2>5. Andmete jagamine</h2>
      <p>Isikuandmeid <b>ei müüda ega jagata</b> kolmandate osapooltega
      turunduslikul eesmärgil. Tehnilisteks teenusteks kasutatakse:
      kaardikihtide kuvamiseks Mapbox (sinu IP edastatakse kaardipiltide
      laadimisel), bottide tõkestamiseks Cloudflare Turnstile ning teenuse
      majutamiseks Railway. Iga teenus töötleb andmeid oma privaatsustingimuste alusel.</p>

      <h2>6. Säilitamine ja kustutamine</h2>
      <p>Konto andmeid säilitatakse seni, kuni konto on aktiivne. Konto
      kustutamisel eemaldatakse isikuandmed <b>30 päeva jooksul</b>. Sinu
      lisatud avalik sisu võidakse säilitada anonümiseeritult.</p>

      <h2>7. Sinu õigused (GDPR)</h2>
      <ul>
        <li>õigus tutvuda enda andmetega ja saada neist koopia;</li>
        <li>õigus andmete parandamisele ja kustutamisele („õigus olla unustatud");</li>
        <li>õigus töötlemise piiramisele ja vastuväite esitamisele;</li>
        <li>õigus võtta nõusolek igal ajal tagasi;</li>
        <li>õigus pöörduda <a href="https://www.aki.ee" target="_blank" rel="noopener">Andmekaitse Inspektsiooni</a> poole.</li>
      </ul>

      <h2>8. Turvalisus</h2>
      <p>Paroolid räsitakse bcrypt-algoritmiga, ühendus on krüpteeritud (HTTPS),
      rakendatud on sisselogimiskatsete piiramine, sisendi valideerimine ning
      turvalised HTTP-päised. Vaatamata meetmetele ei saa ükski süsteem tagada
      100% turvalisust.</p>

      <h2>9. Muudatused</h2>
      <p>Poliitika uuendamisel muudetakse käesoleva lehe kuupäeva. Olulistest
      muudatustest teavitatakse registreeritud kasutajaid.</p>

      <p class="legal-foot">Vaata ka <a href="#/tingimused" data-nav>kasutustingimusi</a>.</p>
    `,
    tingimused: `
      <p class="legal-meta">Viimati uuendatud: ${LEGAL_UPDATED}</p>

      <p>Eesti Mütoloogiaveebi (edaspidi „veeb") kasutamisega nõustud
      järgnevate tingimustega. Kui sa nendega ei nõustu, palun ära veebi kasuta.</p>

      <h2>1. Teenuse kirjeldus</h2>
      <p>Veeb on hariduslik ja kultuuriline infosüsteem Eesti mütoloogilise
      pärimuse kohta. Teenust pakutakse „nagu on" põhimõttel, peamiselt
      õppe-eesmärgil, ilma kättesaadavuse garantiita.</p>

      <h2>2. Konto ja kasutaja kohustused</h2>
      <ul>
        <li>esita registreerimisel tõene info ning hoia oma parool turvaliselt;</li>
        <li>vastutad kõigi oma kontolt tehtud toimingute eest;</li>
        <li>oled vähemalt 13-aastane või kasutad veebi seadusliku esindaja loal.</li>
      </ul>

      <h2>3. Lubatud kasutus</h2>
      <p>Veebi tohib kasutada seaduslikel eesmärkidel. Keelatud on:</p>
      <ul>
        <li>vale, eksitava või solvava sisu lisamine;</li>
        <li>teiste autoriõiguste rikkumine;</li>
        <li>süsteemi turvalisuse rikkumine, automatiseeritud kraapimine või
        ülekoormamine (sh bottidega);</li>
        <li>teiste kasutajate isikuandmete väärkasutus.</li>
      </ul>

      <h2>4. Kasutaja loodud sisu</h2>
      <p>Sina säilitad õigused enda lisatud sisule, kuid annad veebile
      lihtlitsentsi seda õppe-eesmärgil kuvada ja säilitada. Toimetajad võivad
      sisu modereerida, muuta või eemaldada, kui see rikub neid tingimusi.
      Lisatud sisu peab olema korrektselt allikaviidatud.</p>

      <h2>5. Rollid ja modereerimine</h2>
      <p>Uued kasutajad saavad külastaja õigused. Sisu lisamise (toimetaja) ja
      halduse (administraator) õigusi annab veebi haldaja. Lisatud kirjed
      läbivad enne avaldamist modereerimise.</p>

      <h2>6. Intellektuaalomand</h2>
      <p>Veebi tarkvara on avatud lähtekoodiga (MIT litsents). Mütoloogiline
      pärimusmaterjal pärineb avalikest allikatest ja on viidatud vastavalt.</p>

      <h2>7. Vastutuse piiramine</h2>
      <p>Veebi haldaja ei vastuta sisu täielikkuse ega täpsuse eest ega
      kahjude eest, mis tulenevad veebi kasutamisest. Tegemist on
      õppeprojektiga, mitte teadusliku autoriteetallikaga.</p>

      <h2>8. Tingimuste muutmine ja lõpetamine</h2>
      <p>Haldajal on õigus tingimusi muuta ja konto, mis rikub tingimusi,
      peatada või kustutada. Tingimuste tõlgendamisel kohaldatakse Eesti
      Vabariigi õigust.</p>

      <p class="legal-foot">Vaata ka <a href="#/privaatsus" data-nav>privaatsuspoliitikat</a>.</p>
    `,
  };

  function renderLegal(milline) {
    const sisu = LEGAL_SISU[milline] || LEGAL_SISU.privaatsus;
    const el = document.getElementById('legal-' + milline);
    if (el) el.innerHTML = sisu;
  }


  const vaated = {
    '': 'view-home',
    'olendid': 'view-olendid',
    'kaart': 'view-kaart',
    'olend': 'view-detail',
    'admin': 'view-admin',
    'profiil': 'view-profiil',
    'lisa': 'view-vorm',
    'muuda': 'view-vorm',
    'privaatsus': 'view-privaatsus',
    'tingimused': 'view-tingimused',
    'info': 'view-privaatsus',
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
      case 'kaart':
        if (state.suurKaart) state.suurKaart.resize();
        else state.suurKaart = looKihelkonnaKaart({ container: 'map', panel: kaartPaneel() });
        break;
      case 'olend': if (id) await renderDetail(id); break;
      case 'admin': await renderAdmin(); break;
      case 'profiil': await renderProfiil(); break;
      case 'lisa': await renderVorm(null); break;
      case 'muuda': await renderVorm(id); break;
      case 'privaatsus': case 'info': renderLegal('privaatsus'); break;
      case 'tingimused': renderLegal('tingimused'); break;
      default: location.hash = '#/';
    }
  }

  // =========================================================================
  //  SÜNDMUSTE SIDUMINE
  // =========================================================================
  function seoSündmused() {
    // TURVAPARANDUS: ÜKS delegeeritud pildivea käsitleja kõigi inline
    // onerror=""-atribuutide asemel. 'error' sündmus ei mulle (bubble),
    // seega kuulame capture-faasis. Iga <img data-fallback="..."> saab
    // ebaõnnestumisel varuvariandi. Tänu sellele sai CSP-st 'unsafe-inline'
    // eemaldada: süstitud on*-atribuudid ei käivitu enam ÜLDSE.
    document.addEventListener('error', (e) => {
      const img = e.target;
      if (!(img instanceof HTMLImageElement) || !img.dataset.fallback) return;
      const holder = img.parentElement;
      if (!holder) return;
      holder.innerHTML = img.dataset.fallback === 'mountain'
        ? MOUNTAIN_SVG
        : `<div class="placeholder">${esc(img.dataset.fallback)}</div>`;
    }, true);

    // Sfäärifiltri tühjendamine (avalehe külgpaneel)
    const sfReset = $('#sfaar-reset');
    if (sfReset) sfReset.addEventListener('click', () => {
      state.sfaarFilter.clear();
      $$('#sfaar-list .sfaar-item').forEach((i) => {
        i.classList.remove('active');
        i.setAttribute('aria-pressed', 'false');
      });
      rakendaSfaarFilter();
    });

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
        state.olendidCache = null; // roll muutus -> /api/olendid vastus muutub
        await laeLemmikud();
        renderNavAuth();
        suljeAuthModal();
        toast('Tere tulemast, ' + d.kasutaja.kasutajanimi + '!');
        router();
      } catch (err) { authViga(err.message); }
    });

    $('#form-register').addEventListener('submit', async (e) => {
      e.preventDefault();
      // Loe Turnstile token peidetud väljalt (widget lisab selle ise)
      const captchaToken = (window.turnstile && document.querySelector('#reg-turnstile input[name="cf-turnstile-response"]'))
        ? document.querySelector('#reg-turnstile input[name="cf-turnstile-response"]').value
        : '';
      if (!$('#reg-nousolek').checked) {
        return authViga('Pead nõustuma privaatsuspoliitika ja kasutustingimustega.');
      }
      try {
        const d = await api('/auth/register', {
          method: 'POST',
          body: {
            kasutajanimi: $('#reg-kasutajanimi').value.trim(),
            email: $('#reg-email').value.trim(),
            parool: $('#reg-parool').value,
            nousolek: $('#reg-nousolek').checked,
            captchaToken,
          },
        });
        state.kasutaja = d.kasutaja;
        await laeLemmikud();
        renderNavAuth();
        suljeAuthModal();
        toast('Konto loodud! Oled sisse logitud.');
        router();
      } catch (err) {
        if (window.turnstile) window.turnstile.reset('#reg-turnstile'); // lähtesta widget
        authViga(err.message);
      }
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


    // Olendite filtrid (live)
    let timer;
    ['#f-otsing'].forEach((sel) =>
      $(sel).addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(laeOlendiNimekiri, 250); })
    );
    ['#f-sfaar', '#f-kihelkond', '#f-sort'].forEach((sel) =>
      $(sel).addEventListener('change', laeOlendiNimekiri)
    );

    // Vorm: failide üleslaadimine
    seoFailiSisend('pilt');
    seoFailiSisend('heli');

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
        state.olendidCache = null; // sisu muutus -> vahemälu aegus
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