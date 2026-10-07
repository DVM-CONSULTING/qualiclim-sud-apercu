/*!
 * Qualiclim Sud — le chef d'orchestre de la page.
 * Survol vidéo lu au défilement, vol du logo, préchargeur, défilement doux (Lenis), fond continu,
 * révélations des titres (SplitText), apparitions, manifeste, défilé, cartes empilées, parallaxe,
 * scène « Réversible », marques, étapes horizontales, survol 3D de la côte, FAQ, pilules magnétiques,
 * formulaire. Tout se dégrade : sans GSAP, sans WebGL, en mouvement réduit ou sans JavaScript, le texte reste.
 */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const racine = document.documentElement;
  const reduit = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fin = matchMedia('(pointer: fine)').matches;
  const G = window.gsap, ST = window.ScrollTrigger, SPLIT = window.SplitText;
  const MOTION = !!(G && ST) && !reduit;
  if (G && ST) G.registerPlugin(ST); if (G && SPLIT) G.registerPlugin(SPLIT);

  $$('[data-annee]').forEach(e => { e.textContent = new Date().getFullYear(); });
  try { const g = document.createElement('canvas'); g.width = g.height = 160; const x = g.getContext('2d'), im = x.createImageData(160, 160);
    for (let i = 0; i < im.data.length; i += 4) { const v = Math.random() * 255; im.data[i] = im.data[i + 1] = im.data[i + 2] = v; im.data[i + 3] = 255; }
    x.putImageData(im, 0, 0); $('#grain').style.backgroundImage = `url(${g.toDataURL()})`; } catch (e) { /* rien */ }

  // ================================================================== Survol vidéo et vol du logo
  const temps = $$('.temp'), piste = $('#piste'), nav = $('#nav');
  const ins = { etape: $('#ins-etape'), barre: $('#ins-barre') };
  const progression = () => { const r = piste.getBoundingClientRect(); return Math.min(1, Math.max(0, -r.top / Math.max(1, piste.offsetHeight - innerHeight))); };
  const tempsDe = (p) => p < 0.18 ? 0 : p < 0.5 ? 1 : p < 0.78 ? 2 : -1;
  let tCourant = 0;
  const majTemps = (p) => {
    const t = tempsDe(p);
    if (t !== tCourant) { temps[tCourant]?.classList.remove('est-la'); temps[t]?.classList.add('est-la'); tCourant = t; }
    if (t >= 0) ins.etape.textContent = ['Survol', 'Cap sur Fréjus', 'Arrivée à Fréjus'][t];
    ins.barre.style.width = (p * 100).toFixed(1) + '%';
    racine.style.setProperty('--vol', p.toFixed(4));
    const bas = piste.getBoundingClientRect().bottom;
    document.body.classList.toggle('en-brume', p > 0.8);
    nav.classList.toggle('sur-clair', p > 0.8 || bas < 80);
    document.body.classList.toggle('fin-recit', bas < innerHeight * 0.6);
  };

  const scene = $('#scene');
  const portrait = matchMedia('(max-aspect-ratio: 1/1)').matches;
  const v = document.createElement('video');
  const h264 = v.canPlayType('video/mp4; codecs="avc1.640028"') || v.canPlayType('video/mp4');
  const src = 'video/' + (portrait ? 'survol-mobile' : 'survol-bureau') + (h264 ? '.mp4' : '.webm');
  const POIDS = { 'survol-mobile.mp4': 3719277, 'survol-bureau.mp4': 8180443, 'survol-mobile.webm': 3652906, 'survol-bureau.webm': 8809417 };
  v.muted = true; v.defaultMuted = true; v.setAttribute('muted', ''); v.playsInline = true; v.setAttribute('playsinline', ''); v.setAttribute('webkit-playsinline', '');
  v.preload = 'auto'; v.disablePictureInPicture = true; v.setAttribute('aria-hidden', 'true');
  scene.prepend(v);

  // Le fichier est chargé en entier avant la lecture (se déplacer dans une vidéo à moitié téléchargée saccade) ;
  // le préchargeur affiche la progression réelle de ce chargement.
  const compte = $('#compte');
  let affiche = 0;
  function chargerVideo() {
    return fetch(src).then(r => {
      if (!r.ok) throw new Error(r.status);
      const total = Number(r.headers.get('content-length')) || POIDS[src.split('/').pop()] || 6e6;
      if (!r.body || !r.body.getReader) return r.blob();
      const lecteur = r.body.getReader(), morceaux = []; let recu = 0;
      const lire = () => lecteur.read().then(({ done, value }) => {
        if (done) return new Blob(morceaux, { type: h264 ? 'video/mp4' : 'video/webm' });
        morceaux.push(value); recu += value.length; affiche = Math.min(99, Math.round(recu / total * 100)); if (compte) compte.textContent = affiche;
        return lire();
      });
      return lire();
    }).then(b => { v.src = URL.createObjectURL(b); }).catch(() => { v.src = src; });
  }

  let pret = false, courant = 0, enAttente = false, debloquee = false;
  // iPhone : une vidéo jamais lancée n'affiche pas l'image demandée au défilement. On la lance une fraction de seconde,
  // muette, puis on la met en pause : au chargement, et de nouveau au premier contact si Safari l'a refusé.
  const debloquer = () => {
    if (debloquee || !v.src) return;
    const essai = v.play();
    if (essai && essai.then) essai.then(() => { v.pause(); debloquee = true; demander(); }).catch(() => {});
    else { v.pause(); debloquee = true; }
  };
  const premierContact = () => { debloquer(); if (debloquee) ['touchend', 'pointerup', 'click', 'keydown'].forEach(t => removeEventListener(t, premierContact)); };
  ['touchend', 'pointerup', 'click', 'keydown'].forEach(t => addEventListener(t, premierContact, { passive: true }));
  v.addEventListener('loadedmetadata', () => { pret = true; debloquer(); demander(); });
  const montrer = () => { if (!v.classList.contains('pret')) v.classList.add('pret'); };
  v.addEventListener('loadeddata', () => { montrer(); demander(); });
  v.addEventListener('seeked', montrer);

  const mhq = $('#mh-q'), mhn = $('#mh-nom'), sq = $('.signe__q'), sn = $('.signe__nom');
  const borne = (x) => Math.min(1, Math.max(0, x));
  const adoucir = (k) => k < .5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
  function voler(p) {
    const k = borne(p / 0.13), e = adoucir(k);
    mhq.style.transform = ''; const a = mhq.getBoundingClientRect(), b = sq.getBoundingClientRect();
    if (a.height && b.height) {
      const s = b.height / a.height, dx = b.left + b.width / 2 - (a.left + a.width / 2), dy = b.top + b.height / 2 - (a.top + a.height / 2);
      mhq.style.transform = `translate(${(dx * e).toFixed(1)}px, ${(dy * e).toFixed(1)}px) scale(${(1 + (s - 1) * e).toFixed(4)})`;
    }
    mhq.style.opacity = k >= 1 ? 0 : 1; sq.style.opacity = k >= 1 ? 1 : 0;
    mhn.style.opacity = 1 - borne(k * 1.7); mhn.style.transform = `translateY(${(-24 * e).toFixed(1)}px)`;
    sn.style.opacity = borne((k - .55) / .45);
  }
  function image() {
    enAttente = false;
    const p = progression();
    majTemps(p); voler(p);
    if (!pret || !v.duration) return;
    const cible = p * (v.duration - 0.05);
    courant += (cible - courant) * (reduit ? 1 : 0.18);
    if (Math.abs(cible - courant) < 0.004) courant = cible;
    if (!v.seeking && Math.abs(v.currentTime - courant) > 0.008) v.currentTime = courant;
    if (courant !== cible) demander();
  }
  function demander() { if (!enAttente) { enAttente = true; requestAnimationFrame(image); } }
  v.addEventListener('seeked', demander);
  addEventListener('scroll', demander, { passive: true });
  addEventListener('resize', demander);
  [mhq, sq].forEach(i => i.addEventListener('load', demander));
  demander();

  // ================================================================== Défilement doux
  let lenis = null;
  if (MOTION && window.Lenis && fin) {
    lenis = new window.Lenis({ lerp: 0.1, smoothWheel: true });
    lenis.on('scroll', ST.update);
    G.ticker.add(t => lenis.raf(t * 1000)); G.ticker.lagSmoothing(0);
  }
  // Ancres : défilement doux vers la section, en tenant compte de l'en-tête
  $$('a[href^="#"]').forEach(a => a.addEventListener('click', e => {
    const id = a.getAttribute('href'); if (id.length < 2) return; const cible = $(id); if (!cible) return;
    e.preventDefault();
    if (lenis) lenis.scrollTo(cible, { offset: id === '#haut' ? 0 : -70, duration: 1.4 }); else cible.scrollIntoView({ behavior: reduit ? 'auto' : 'smooth' });
    if (cible.matches('h2, h3, section') || cible.id) { cible.setAttribute('tabindex', '-1'); cible.focus({ preventScroll: true }); }
    history.replaceState(null, '', id);
  }));

  // ================================================================== Préchargeur
  const pre = $('#prechargeur'), etat = $('#etat-chargement');
  if (lenis) lenis.stop();
  let leve = false;
  function lever() {
    if (leve) return; leve = true;
    if (compte) compte.textContent = 100;
    if (etat) etat.textContent = 'Page chargée.';
    if (lenis) lenis.start();
    if (MOTION) {
      G.to(pre, { yPercent: -100, duration: 1.1, ease: 'power4.inOut', delay: 0.15, onComplete: () => { pre.remove(); ST.refresh(); } });
      G.from('.mh-entree--q', { scale: .82, opacity: 0, duration: 1.4, ease: 'power3.out', delay: .55 });
      G.from('.mh-entree--nom', { y: 26, opacity: 0, duration: 1.2, ease: 'power3.out', delay: .8 });
      G.from('.ouverture .bas > *', { y: 30, opacity: 0, duration: 1, ease: 'power3.out', delay: .95, stagger: .083 });
      G.from('.nav > *', { y: -16, opacity: 0, duration: .9, ease: 'power3.out', delay: 1.05, stagger: .083, clearProps: 'transform' });
    } else { pre.classList.add('parti'); pre.style.display = 'none'; }
  }
  const departPre = performance.now();
  chargerVideo().then(() => { const reste = Math.max(0, 900 - (performance.now() - departPre)); setTimeout(lever, reste); });
  setTimeout(lever, 7000); // jamais plus de 7 s d'attente : la vidéo finira de charger derrière

  initGalerie(); // la visionneuse marche partout, même sans GSAP ni mouvement

  if (!(G && ST)) return; // sans GSAP : la page reste lisible, rien d'autre à animer

  if (reduit) { initReversible(); initZone(); initFaq(); initFormulaire(); fondContinu(); ST.refresh(); return; }

  // ================================================================== Titres : la ligne sort de son masque
  if (SPLIT) {
    $$('[data-titre]').forEach(el => {
      SPLIT.create(el, { type: 'lines', mask: 'lines', autoSplit: true, linesClass: 'ligne',
        onSplit: (self) => G.from(self.lines, { yPercent: 105, duration: 1, ease: 'power4.out', stagger: 0.083, scrollTrigger: { trigger: el, start: 'top 86%', once: true } }) });
    });
  }
  // Apparitions des blocs
  ST.batch('[data-apparait], .tete > p:not(.sur-titre), .sur-titre', {
    start: 'top 88%', once: true,
    onEnter: (els) => G.from(els, { y: 36, opacity: 0, duration: .9, ease: 'power3.out', stagger: .083, overwrite: true })
  });

  // ================================================================== Manifeste : les mots s'allument au défilement
  const mani = $('[data-mots]');
  if (mani) {
    const mots = mani.textContent.trim().split(/\s+/);
    mani.innerHTML = mots.map(m => `<span class="mot">${m.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</span>`).join(' ');
    const spans = $$('.mot', mani);
    ST.create({ trigger: mani, start: 'top 80%', end: 'bottom 45%', scrub: true,
      onUpdate: s => { const n = Math.round(s.progress * spans.length); spans.forEach((sp, i) => sp.classList.toggle('allume', i < n)); } });
  }
  // Défilé « Air · Confort · … »
  const defile = $('[data-defile]');
  if (defile) G.fromTo(defile, { xPercent: 0 }, { xPercent: -50, ease: 'none', scrollTrigger: { trigger: '.defile', start: 'top bottom', end: 'bottom top', scrub: true } });

  // ================================================================== Cartes empilées et parallaxe
  G.matchMedia().add('(min-width: 821px)', () => {
    const cartes = $$('.pile__carte');
    cartes.forEach((c, i) => {
      const suivante = cartes[i + 1]; if (!suivante) return;
      G.fromTo(c, { scale: 1, filter: 'brightness(1)' }, { scale: 0.93, filter: 'brightness(0.88)', ease: 'none', scrollTrigger: { trigger: suivante, start: 'top 85%', end: 'top 20%', scrub: true } });
    });
  });
  $$('[data-parallaxe]').forEach(img => G.fromTo(img, { yPercent: -6 }, { yPercent: 6, ease: 'none', scrollTrigger: { trigger: img.parentElement, start: 'top bottom', end: 'bottom top', scrub: true } }));

  // ================================================================== Réalisations : chaque photo sort de son rideau
  $$('.photo').forEach((f, k) => {
    const cadre = $('.photo__cadre', f), im = $('img', f); if (!cadre || !im) return;
    G.timeline({ scrollTrigger: { trigger: f, start: 'top 86%', once: true } })
      .fromTo(cadre, { clipPath: 'inset(100% 0% 0% 0% round 10px)' }, { clipPath: 'inset(0% 0% 0% 0% round 10px)', duration: 1.25, ease: 'power4.inOut', delay: (k % 2) * 0.12 })
      .fromTo(im, { scale: 1.28 }, { scale: 1, duration: 1.7, ease: 'power3.out' }, '<')
      .from($('figcaption', f), { y: 18, opacity: 0, duration: .8, ease: 'power3.out' }, '<+=.5')
      .fromTo($('.photo__plus', f), { scale: 0, opacity: 0 }, { scale: 1, opacity: 1, duration: .6, ease: 'back.out(2)' }, '<');
    G.fromTo(im, { yPercent: -5 }, { yPercent: 5, ease: 'none', scrollTrigger: { trigger: f, start: 'top bottom', end: 'bottom top', scrub: true } });
  });
  // Pastille « Agrandir » qui suit le pointeur sur les photos
  const galerie = $('#galerie'), curseur = $('.galerie__curseur');
  if (fin && galerie && curseur && matchMedia('(hover: hover)').matches) {
    racine.classList.add('js-curseur');
    G.set(curseur, { xPercent: -50, yPercent: -50, scale: .4 });
    const xC = G.quickTo(curseur, 'x', { duration: .45, ease: 'power3.out' }), yC = G.quickTo(curseur, 'y', { duration: .45, ease: 'power3.out' });
    galerie.addEventListener('pointermove', e => { const r = galerie.getBoundingClientRect(); xC(e.clientX - r.left); yC(e.clientY - r.top); });
    $$('.photo__ouvrir', galerie).forEach(a => {
      a.addEventListener('pointerenter', () => G.to(curseur, { scale: 1, opacity: 1, duration: .4, ease: 'power3.out', overwrite: 'auto' }));
      a.addEventListener('pointerleave', () => G.to(curseur, { scale: .4, opacity: 0, duration: .3, ease: 'power2.out', overwrite: 'auto' }));
    });
  }

  // ================================================================== Marques : les noms se remplissent
  $$('[data-remplit]').forEach(el => G.fromTo(el, { '--plein': '0%' }, { '--plein': '100%', ease: 'none', scrollTrigger: { trigger: el, start: 'top 88%', end: 'top 40%', scrub: true } }));
  $$('.marque-nom').forEach((el, i) => G.fromTo(el, { xPercent: i % 2 ? -6 : 6 }, { xPercent: i % 2 ? 4 : -4, ease: 'none', scrollTrigger: { trigger: el, start: 'top bottom', end: 'bottom top', scrub: true } }));

  initReversible();

  // ================================================================== Étapes : défilement horizontal épinglé
  G.matchMedia().add('(min-width: 1024px) and (pointer: fine)', () => {
    const rail = $('.deroule__piste'), barre = $('#deroule-b');
    const distance = () => Math.max(0, rail.scrollWidth - innerWidth);
    G.to(rail, { x: () => -distance(), ease: 'none', scrollTrigger: { trigger: '.deroule__epingle', start: 'top top+=40', end: () => '+=' + distance(), pin: true, scrub: true, invalidateOnRefresh: true,
      onUpdate: s => { if (barre) barre.style.width = (s.progress * 100).toFixed(1) + '%'; } } });
  });
  G.from('.etape-carte', { y: 50, opacity: 0, duration: 1, ease: 'power3.out', stagger: .083, scrollTrigger: { trigger: '.deroule__piste', start: 'top 85%', once: true } });

  // Compteurs : les numéros d'index grossissent depuis zéro (jamais un chiffre légal)
  $$('.pile__texte .n, .etape-carte__n').forEach(el => {
    const fin2 = el.textContent.trim(); const n = parseInt(fin2, 10); if (!n) return; const o = { v: 0 };
    G.to(o, { v: n, duration: 1.1, ease: 'power2.out', scrollTrigger: { trigger: el, start: 'top 90%', once: true }, onUpdate: () => { el.textContent = String(Math.round(o.v)).padStart(2, '0'); } });
  });

  // Pilules magnétiques (pointeur fin seulement)
  if (fin) $$('[data-magnetique]').forEach(el => {
    const xTo = G.quickTo(el, 'x', { duration: .5, ease: 'power3.out' }), yTo = G.quickTo(el, 'y', { duration: .5, ease: 'power3.out' });
    el.addEventListener('mousemove', e => { const r = el.getBoundingClientRect(); xTo((e.clientX - r.left - r.width / 2) * 0.22); yTo((e.clientY - r.top - r.height / 2) * 0.32); });
    el.addEventListener('mouseleave', () => { xTo(0); yTo(0); });
  });

  initZone(); initFaq(); initFormulaire(); fondContinu(); ST.sort(); ST.refresh();
  addEventListener('load', () => ST.refresh());
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => ST.refresh());

  // ================================================================== Positions : recalculées quand la page change de hauteur
  // (simulateur qui s'agrandit, FAQ ouverte) — sinon les sections épinglées plus bas se décalent.
  function fondContinu() {
    let minuteur = 0, hauteur = document.documentElement.scrollHeight;
    if (!('ResizeObserver' in window)) return;
    new ResizeObserver(() => {
      const h = document.documentElement.scrollHeight; if (Math.abs(h - hauteur) < 4) return; hauteur = h;
      clearTimeout(minuteur); minuteur = setTimeout(() => ST.refresh(), 180);
    }).observe(document.getElementById('site'));
  }

  // ================================================================== Réversible (scène WebGL du module)
  function initReversible() {
    const sec = $('#climatisation'), hote = $('#climatisation .rev-scene'), R = window.QualiclimReversible;
    if (!sec || !hote || !R) return;
    sec.style.setProperty('--rev-affiche', 'url("../img/reversible-affiche.webp")');
    let scene3d = null, texte = null, monte = false;
    const monter = () => { if (monte) return; monte = true; try { scene3d = R.monter(hote); texte = R.texte(sec); } catch (e) { scene3d = null; } };
    if (reduit || !(G && ST)) { monter(); return; }
    ST.create({ trigger: sec, start: 'top bottom+=50%', once: true, onEnter: monter });
    ST.create({ trigger: hote, start: 'top top', end: '+=220%', pin: true, scrub: true, anticipatePin: 1,
      onUpdate: s => { monter(); if (scene3d) scene3d.regler(s.progress); if (texte) texte.regler(s.progress); } });
  }

  // ================================================================== Secteur : survol 3D de la côte, de Fréjus à Cannes
  function initZone() {
    const hote = $('#zone-scene'), C = window.QualiclimCote, items = $$('.zone__communes li');
    if (!hote) return;
    const LIEUX = [
      { nom: 'Fréjus · notre dépôt', lon: 6.736, lat: 43.433, depot: true, de: 0, a: .32 },
      { nom: 'Saint-Raphaël', lon: 6.769, lat: 43.425, de: .04, a: .42 },
      { nom: 'Agay', lon: 6.857, lat: 43.433, de: .24, a: .62 },
      { nom: 'Théoule-sur-Mer', lon: 6.940, lat: 43.508, de: .48, a: .86 },
      { nom: 'Mandelieu-la-Napoule', lon: 6.938, lat: 43.546, de: .64, a: 1.01 },
      { nom: 'Cannes', lon: 7.013, lat: 43.552, de: .7, a: 1.01 }
    ];
    let cote = null, p = 0;
    const allumer = (q) => items.forEach(li => li.classList.toggle('atteinte', q >= parseFloat(li.dataset.de)));
    const monter = () => { if (monter.fait || !C) return; monter.fait = true; C.monter(hote, { base: 'cote/', lieux: LIEUX }).then(c => { cote = c; if (cote) cote.regler(p); }); };
    if (reduit || !(G && ST)) { allumer(1); return; }
    ST.create({ trigger: '#zone', start: 'top bottom+=120%', once: true, onEnter: monter });
    ST.create({ trigger: '.zone__epingle', start: 'top top', end: '+=260%', pin: true, scrub: true, anticipatePin: 1,
      onUpdate: s => { p = s.progress; monter(); if (cote) cote.regler(p); allumer(p); } });
    G.from('.zone__communes li', { y: 20, opacity: 0, duration: .8, ease: 'power3.out', stagger: .06, scrollTrigger: { trigger: '.zone__epingle', start: 'top 70%', once: true } });
  }

  // ================================================================== Visionneuse des photos de chantier
  // Sans <dialog> ou sans JavaScript, chaque lien ouvre simplement la photo en grand.
  function initGalerie() {
    const liens = $$('.photo__ouvrir'), dlg = $('#visionneuse');
    if (!liens.length || !dlg || typeof dlg.showModal !== 'function') return;
    const img = $('#visionneuse-img'), leg = $('#visionneuse-legende'), num = $('#visionneuse-n');
    const photos = liens.map(a => ({ src: a.getAttribute('href'), alt: $('img', a).alt, leg: $('figcaption span:last-child', a.closest('figure')).textContent.trim() }));
    let i = 0, retour = null, x0 = null, glisse = false;
    const montrer = (k, sens) => {
      i = (k + photos.length) % photos.length; const p = photos[i];
      img.src = p.src; img.alt = p.alt; leg.textContent = p.leg; num.textContent = i + 1;
      if (MOTION && sens) G.fromTo(img, { x: sens * 48, opacity: 0 }, { x: 0, opacity: 1, duration: .6, ease: 'power3.out', overwrite: true });
      new Image().src = photos[(i + 1) % photos.length].src; // la suivante se prépare
    };
    liens.forEach((a, k) => a.addEventListener('click', e => {
      e.preventDefault(); retour = a; montrer(k, 0);
      dlg.showModal(); racine.classList.add('visionneuse-ouverte'); if (lenis) lenis.stop();
      if (MOTION) { G.fromTo(dlg, { opacity: 0 }, { opacity: 1, duration: .35, ease: 'power2.out' }); G.fromTo(img, { scale: .94, opacity: 0 }, { scale: 1, opacity: 1, duration: .8, ease: 'power3.out', overwrite: true }); }
    }));
    dlg.addEventListener('close', () => { racine.classList.remove('visionneuse-ouverte'); if (lenis) lenis.start(); if (retour) retour.focus({ preventScroll: true }); });
    $('[data-fermer]', dlg).addEventListener('click', () => dlg.close());
    $$('[data-pas]', dlg).forEach(b => b.addEventListener('click', () => { const d = Number(b.dataset.pas); montrer(i + d, d); }));
    dlg.addEventListener('keydown', e => { if (e.key === 'ArrowRight') montrer(i + 1, 1); else if (e.key === 'ArrowLeft') montrer(i - 1, -1); });
    // Au doigt : glisser à gauche ou à droite pour changer de photo
    dlg.addEventListener('pointerdown', e => { glisse = false; x0 = e.pointerType === 'mouse' ? null : e.clientX; });
    dlg.addEventListener('pointerup', e => { if (x0 === null) return; const d = e.clientX - x0; x0 = null; if (Math.abs(d) > 50) { glisse = true; montrer(i + (d < 0 ? 1 : -1), d < 0 ? 1 : -1); } });
    // Un clic hors de la photo et des boutons referme
    dlg.addEventListener('click', e => { if (!glisse && (e.target === dlg || e.target.classList.contains('visionneuse__photo'))) dlg.close(); glisse = false; });
  }

  // ================================================================== FAQ : ouverture animée
  function initFaq() {
    $$('.faq').forEach(d => {
      const s = $('summary', d), corps = $('.faq__corps', d);
      if (!s || !corps || reduit || !G) return;
      s.addEventListener('click', e => {
        e.preventDefault();
        if (d.open) { G.to(corps, { height: 0, opacity: 0, duration: .45, ease: 'power3.inOut', onComplete: () => { d.open = false; G.set(corps, { clearProps: 'height,opacity' }); ST.refresh(); } }); }
        else { d.open = true; G.fromTo(corps, { height: 0, opacity: 0 }, { height: 'auto', opacity: 1, duration: .6, ease: 'power3.out', onComplete: () => { G.set(corps, { clearProps: 'height' }); ST.refresh(); } }); }
      });
    });
  }

  // ================================================================== Formulaire de contact
  function initFormulaire() {
    const f = $('#formulaire'); if (!f) return;
    const out = $('#f-retour'), bouton = $('.formulaire__envoi', f), lib = $('.formulaire__lib', f);
    const PROJETS = { installation: 'Une installation', remplacement: 'Remplacer un appareil', plusieurs: 'Plusieurs pièces', question: 'Une question' };
    let enCours = false;
    f.addEventListener('submit', async e => {
      e.preventDefault();
      if (enCours) return;
      $$('.flottant', f).forEach(x => x.classList.remove('erreur'));
      const nom = $('#f-nom'), tel = $('#f-tel'), mail = $('#f-mail');
      const manque = [];
      if (nom.value.trim().length < 2) manque.push(nom);
      if (!/^[+0-9 ().-]{9,}$/.test(tel.value.trim())) manque.push(tel);
      if (mail.value.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail.value.trim())) manque.push(mail);
      if (manque.length) {
        manque.forEach(x => x.closest('.flottant').classList.add('erreur'));
        out.textContent = manque[0] === nom ? 'Indiquez votre nom.' : manque[0] === tel ? 'Indiquez un numéro de téléphone valide.' : 'Cette adresse e-mail semble incomplète.';
        manque[0].focus(); return;
      }
      const projet = (f.querySelector('[name=projet]:checked') || {}).value, commune = $('#f-commune').value, rappel = $('[name=rappel]', f).checked;
      const message = [`Projet : ${PROJETS[projet] || 'non précisé'}`, `Commune : ${commune || 'non précisée'}`, rappel ? 'Souhaite être rappelé·e.' : 'Ne demande pas de rappel.', '', $('#f-msg').value.trim() || '(pas de message)'].join('\n');
      enCours = true; bouton.classList.add('envoi-en-cours'); lib.textContent = 'Envoi…'; out.textContent = '';
      const r = window.QualiclimEnvoi ? await window.QualiclimEnvoi.envoyer({ nom: nom.value.trim(), telephone: tel.value.trim(), email: mail.value.trim(), message, site_web: $('#f-site').value, rappel, details: [['Projet', PROJETS[projet] || 'non précisé'], ['Commune', commune || 'non précisée']], note: $('#f-msg').value.trim() }, 'contact') : { ok: false, nonRelie: true };
      enCours = false; bouton.classList.remove('envoi-en-cours');
      if (r.ok) {
        f.classList.add('envoye'); lib.textContent = 'Demande envoyée';
        out.textContent = 'Merci, votre demande est bien partie.' + (rappel ? ' Nous vous rappelons au numéro indiqué.' : ' Nous vous répondons rapidement.');
      } else if (r.nonRelie) {
        lib.textContent = 'Envoyer ma demande';
        out.textContent = "Aperçu du site : le formulaire sera relié à la mise en ligne, rien n'a été envoyé. En attendant, appelez-nous au 06 34 49 32 49.";
      } else {
        lib.textContent = 'Réessayer';
        out.textContent = (r.erreurs && r.erreurs.length ? r.erreurs.join(' ') + ' ' : "Votre demande n'a pas pu partir. ") + 'Vous pouvez aussi nous appeler au 06 34 49 32 49.';
      }
    });
  }
})();
