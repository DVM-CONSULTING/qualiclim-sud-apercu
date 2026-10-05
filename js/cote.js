/*!
 * Qualiclim Sud — « De Fréjus à Cannes » : survol 3D de la côte, piloté par le défilement.
 * Photos aériennes IGN BD ORTHO® et relief RGE ALTI® (Licence Ouverte Etalab 2.0), fonds marins EMODnet,
 * rivage OpenStreetMap. Dépend de window.THREE (three.js r128).
 *
 * API : QualiclimCote.monter(hote, { base, lieux }) → Promise<{ regler(p), pause(), reprise(), detruire() } | null>
 *  - le canvas est décoratif (aria-hidden, pointer-events: none), n'écoute ni molette ni pointeur ;
 *  - rendu à la demande : une image seulement quand la progression ou la taille change ;
 *  - sans WebGL, en mouvement réduit ou si les données ne chargent pas : null (l'image fixe reste).
 */
(function () {
  'use strict';
  var LON0 = 6.9, LAT0 = 43.45, KX = 111.32 * Math.cos(LAT0 * Math.PI / 180), KZ = 111.13, EXAG = 1.6;
  var ZONE = { W: 6.45, E: 7.35, S: 43.15, N: 43.75, nx: 480, ny: 436 };

  // Trajectoire : la caméra longe la côte au large, de Fréjus jusqu'à Cannes. [lon, lat, altitude km]
  var CLES = [
    { c: [6.715, 43.335, 3.6], v: [6.745, 43.432, 0.0] },
    { c: [6.775, 43.338, 3.0], v: [6.790, 43.428, 0.05] },
    { c: [6.850, 43.362, 2.7], v: [6.862, 43.445, 0.15] },
    { c: [6.925, 43.410, 2.8], v: [6.928, 43.497, 0.15] },
    { c: [6.990, 43.448, 3.4], v: [6.975, 43.540, 0.05] },
    { c: [7.050, 43.470, 4.4], v: [7.005, 43.552, 0.0] }
  ];

  function webglDispo() {
    try { var c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch (e) { return false; }
  }

  function monter(hote, options) {
    var o = options || {}, THREE = window.THREE;
    if (!hote || !THREE || !webglDispo()) return Promise.resolve(null);
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return Promise.resolve(null);
    var base = o.base || 'cote/';
    return fetch(base + 'hauteurs.i16').then(function (r) { if (!r.ok) throw new Error('relief'); return r.arrayBuffer(); })
      .then(function (buf) { return construire(hote, THREE, new Int16Array(buf), base, o); })
      .catch(function () { return null; });
  }

  function construire(hote, THREE, H, base, o) {
    var P = function (lon, lat, y) { return new THREE.Vector3((lon - LON0) * KX, y || 0, -(lat - LAT0) * KZ); };
    var rendu = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    rendu.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    var canvas = rendu.domElement;
    canvas.className = 'cote-toile'; canvas.setAttribute('aria-hidden', 'true');
    hote.insertBefore(canvas, hote.firstChild);
    var scene = new THREE.Scene();
    var camera = new THREE.PerspectiveCamera(38, 1, 0.03, 320);
    var SOLEIL = new THREE.Vector3(-0.72, 0.5, 0.48).normalize();
    var U = {
      soleil: { value: SOLEIL }, temps: { value: 0 },
      zenith: { value: new THREE.Color('#1d5ea6') }, horizon: { value: new THREE.Color('#e3e6e4') }, chaud: { value: new THREE.Color('#ffd9a8') },
      brume: { value: 0.0095 }
    };
    var COMMUN = [
      'uniform vec3 soleil, zenith, horizon, chaud; uniform float temps, brume;',
      'vec3 lin(vec3 c){ return pow(c, vec3(2.2)); }',
      'vec3 finir(vec3 c){ c *= 1.08; c = clamp((c*(2.51*c + .03)) / (c*(2.43*c + .59) + .14), 0., 1.); c = pow(c, vec3(1./2.2));',
      '  float g = dot(c, vec3(.3,.59,.11)); c = mix(vec3(g), c, 1.12); return mix(c, c*vec3(1.02, 1., .97), .6); }',
      'vec3 cielDir(vec3 d){ float h = clamp(d.y*1.8 + .03, 0., 1.); vec3 c = mix(lin(horizon), lin(zenith), pow(h, .42));',
      '  float s = max(dot(d, soleil), 0.); c += lin(chaud) * (pow(s, 6.)*.35 + pow(s, 64.)*.6); return c; }',
      'float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7)))*43758.5453); }',
      'float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.-2.*f); return mix(mix(h21(i), h21(i+vec2(1,0)), f.x), mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), f.x), f.y); }',
      'float ombreNuage(vec2 xz){ vec2 p = xz*.055 + vec2(temps*.004, temps*.002); return .5*vn(p) + .25*vn(p*2.03 + 17.1) + .125*vn(p*4.12 + 51.4) + .06; }',
      'vec3 brumer(vec3 c, vec3 W){ vec3 d = W - cameraPosition; float L = length(d); vec3 v = d / L;',
      '  float hauteur = exp(-max(min(W.y, cameraPosition.y), 0.)*.22);',
      '  float f = 1. - exp(-L*brume*hauteur); vec3 col = cielDir(v); col += lin(chaud)*pow(max(dot(v, soleil), 0.), 8.)*.25;',
      '  return mix(c, col, clamp(f, 0., 1.)); }',
      'vec3 mer(vec3 base, vec3 W, vec3 V, float cote){',
      '  vec2 q = W.xz*7.; vec2 q2 = W.xz*55.;',
      '  vec3 n = normalize(vec3((vn(q + temps*.25) - .5)*.07 + (vn(q2 - temps*.6) - .5)*.03, 1., (vn(q*1.3 + 9. - temps*.2) - .5)*.07 + (vn(q2*1.2 + 4. + temps*.5) - .5)*.03));',
      '  float fres = .02 + .98*pow(1. - max(dot(V, n), 0.), 5.);',
      '  vec3 c = mix(base, cielDir(reflect(-V, n)), fres*.85);',
      '  c += lin(chaud) * pow(max(dot(reflect(-soleil, n), V), 0.), 380.) * 3. * (1. - cote);',
      '  return c; }'
    ].join('\n');

    var chargeur = new THREE.TextureLoader(), aCharger = 2, pret = false, resoudre;
    var finiCharge = new Promise(function (r) { resoudre = r; });
    function tex(src) {
      var t = chargeur.load(src, function () { aCharger--; if (!aCharger) { pret = true; resoudre(); demander(); } }, undefined, function () { aCharger--; if (!aCharger) resoudre(); });
      t.anisotropy = Math.min(8, rendu.capabilities.getMaxAnisotropy()); return t;
    }

    // Ciel
    scene.add(new THREE.Mesh(new THREE.SphereGeometry(300, 48, 24), new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, uniforms: U,
      vertexShader: 'varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; gl_Position.z = gl_Position.w; }',
      fragmentShader: COMMUN + '\nvarying vec3 vW; void main(){ vec3 c = cielDir(normalize(vW - cameraPosition)); gl_FragColor = vec4(finir(c), 1.); }'
    })));

    // Terrain : grille RGE ALTI + photo IGN + masque terre/mer
    var z = ZONE, L = (z.E - z.W) * KX, Hh = (z.N - z.S) * KZ;
    var g = new THREE.PlaneGeometry(L, Hh, z.nx - 1, z.ny - 1); g.rotateX(-Math.PI / 2);
    g.translate(((z.W + z.E) / 2 - LON0) * KX, 0, -((z.S + z.N) / 2 - LAT0) * KZ);
    var pos = g.attributes.position, prof = new Float32Array(z.nx * z.ny);
    for (var j = 0; j < z.ny; j++) for (var i = 0; i < z.nx; i++) {
      var k = j * z.nx + i, h = H[k];
      pos.setY(k, Math.max(h, 0) * EXAG / 1000); prof[k] = h;
    }
    g.setAttribute('prof', new THREE.BufferAttribute(prof, 1)); g.computeVertexNormals();
    var tOrtho = tex(base + 'ortho.jpg'), tMasque = tex(base + 'masque-rg.png');
    scene.add(new THREE.Mesh(g, new THREE.ShaderMaterial({
      uniforms: Object.assign({ tOrtho: { value: tOrtho }, tMasque: { value: tMasque } }, U),
      vertexShader: 'attribute float prof; varying vec2 vUv; varying vec3 vN, vW; varying float vP;\nvoid main(){ vUv = uv; vN = normal; vP = prof; vec4 w = modelMatrix * vec4(position,1.); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
      fragmentShader: COMMUN + [
        '\nuniform sampler2D tOrtho, tMasque; varying vec2 vUv; varying vec3 vN, vW; varying float vP;',
        'void main(){',
        '  vec3 o = texture2D(tOrtho, vUv).rgb; vec2 m = texture2D(tMasque, vUv).rg;',
        '  float terre = smoothstep(.4, .6, m.r); vec3 V = normalize(cameraPosition - vW);',
        '  vec3 ol = lin(o); float gris = dot(ol, vec3(.3,.59,.11));',
        '  ol = mix(vec3(gris), ol, 1.3); ol = pow(ol, vec3(1.05)) * 1.2 * vec3(1.06, 1.0, .9);',
        '  vec3 N = normalize(vN); float l = max(dot(N, soleil), 0.);',
        '  float ombre = 1. - .32*smoothstep(.52, .74, ombreNuage(vW.xz - soleil.xz/soleil.y*4.));',
        '  vec3 cTerre = ol * (.5 + .95*l) * ombre;',
        '  float p = clamp(-vP / 700., 0., 1.);',
        '  vec3 base = mix(lin(vec3(.09,.42,.49)), lin(vec3(.02,.15,.27)), pow(p, .4));',
        '  float valide = 1. - step(.92, min(o.r, min(o.g, o.b)));',
        '  float cote = clamp(m.g*1.3, 0., 1.);',
        '  base = mix(base, ol*vec3(.92, 1.02, 1.08), cote*.85*valide);',
        '  vec3 c = mix(mer(base, vW, V, cote) * ombre, cTerre, terre);',
        '  float bord = min(min(vUv.x, 1. - vUv.x), min(vUv.y, 1. - vUv.y));',
        '  c = brumer(c, vW);',
        '  c = mix(c, cielDir(normalize(vW - cameraPosition)), (1. - smoothstep(0., .06, bord))*terre);',
        '  gl_FragColor = vec4(finir(c), 1.);',
        '}'].join('\n')
    })));

    // Mer au large, jusqu'à l'horizon
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(600, 330).rotateX(-Math.PI / 2).translate(0, -0.015, -(ZONE.N - LAT0) * KZ + 169), new THREE.ShaderMaterial({
      uniforms: U,
      vertexShader: 'varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
      fragmentShader: COMMUN + '\nvarying vec3 vW; void main(){ vec3 V = normalize(cameraPosition - vW); float ombre = 1. - .32*smoothstep(.52, .74, ombreNuage(vW.xz - soleil.xz/soleil.y*4.));\n vec3 c = mer(lin(vec3(.02,.15,.27)), vW, V, 0.) * ombre; gl_FragColor = vec4(finir(brumer(c, vW)), 1.); }'
    })));

    // Repères (DOM) projetés sur la scène
    var calque = hote.querySelector('.cote-reperes');
    var LIEUX = (o.lieux || []).map(function (l) {
      var e = document.createElement('div');
      e.className = 'repere' + (l.depot ? ' repere--depot' : '');
      e.innerHTML = '<span class="repere__nom"></span><span class="repere__tige"></span><span class="repere__pied"></span>';
      e.firstChild.textContent = l.nom;
      if (calque) calque.appendChild(e);
      return { el: e, v: P(l.lon, l.lat, l.y || 0.03), de: l.de, a: l.a };
    });

    var courbeC, courbeV, enAttente = false, detruit = false, enPause = false, p = 0, w = 0, hpx = 0;
    function trajectoire() {
      var etroit = w / Math.max(1, hpx) < 0.8;
      courbeC = new THREE.CatmullRomCurve3(CLES.map(function (k) { var v = P(k.c[0], k.c[1], k.c[2]); if (etroit) v.y += 0.9; return v; }), false, 'centripetal', 0.5);
      courbeV = new THREE.CatmullRomCurve3(CLES.map(function (k) { return P(k.v[0], k.v[1], k.v[2]); }), false, 'centripetal', 0.5);
    }
    function taille() {
      var r = hote.getBoundingClientRect(); w = Math.max(1, Math.round(r.width)); hpx = Math.max(1, Math.round(r.height));
      rendu.setSize(w, hpx, false);
      camera.aspect = w / hpx; camera.fov = w / hpx < 0.8 ? 58 : 38; camera.updateProjectionMatrix();
      trajectoire(); demander();
    }
    var v3 = new THREE.Vector3();
    function lisse(t) { return t * t * (3 - 2 * t); }
    function image(t) {
      enAttente = false;
      if (detruit || enPause || !pret) return;
      var u = lisse(Math.min(1, Math.max(0, p)));
      camera.position.copy(courbeC.getPoint(u)); camera.lookAt(courbeV.getPoint(u));
      U.temps.value = (t || 0) / 1000;
      rendu.render(scene, camera);
      for (var n = 0; n < LIEUX.length; n++) {
        var Li = LIEUX[n]; v3.copy(Li.v).project(camera);
        var ok = p >= Li.de && p <= Li.a && v3.z < 1 && Math.abs(v3.x) < 0.94 && v3.y > -0.6 && v3.y < 0.86;
        Li.el.style.opacity = ok ? 1 : 0;
        if (ok) Li.el.style.transform = 'translate(' + ((v3.x * 0.5 + 0.5) * w).toFixed(1) + 'px,' + ((-v3.y * 0.5 + 0.5) * hpx).toFixed(1) + 'px) translate(-50%, -100%)';
      }
      // La mer vit : quelques images de plus tant que la section est à l'écran
      if (!window.__fige && vivant) demander();
    }
    var vivant = false;
    function demander() { if (!enAttente && !detruit) { enAttente = true; requestAnimationFrame(image); } }
    var io = new IntersectionObserver(function (es) { vivant = es[0].isIntersecting; if (vivant) demander(); }, { rootMargin: '10% 0px' });
    io.observe(hote);
    var ro = new ResizeObserver(taille); ro.observe(hote);
    canvas.addEventListener('webglcontextlost', function (e) { e.preventDefault(); });
    canvas.addEventListener('webglcontextrestored', demander);
    taille();

    function detruire() {
      if (detruit) return; detruit = true; io.disconnect(); ro.disconnect();
      scene.traverse(function (ob) { if (ob.geometry) ob.geometry.dispose(); if (ob.material) ob.material.dispose(); });
      tOrtho.dispose(); tMasque.dispose(); rendu.dispose(); canvas.remove();
      LIEUX.forEach(function (l) { l.el.remove(); });
    }
    return finiCharge.then(function () {
      hote.classList.add('cote--vivant');
      return {
        regler: function (q) { p = q; demander(); },
        pause: function () { enPause = true; },
        reprise: function () { enPause = false; demander(); },
        detruire: detruire
      };
    });
  }

  window.QualiclimCote = { monter: monter };
})();
