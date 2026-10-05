/*!
 * Qualiclim Sud — scène WebGL « Réversible » (module autonome, script classique).
 * Spécification : specs/mouvement.md §6. Dépend de window.THREE (three.js r128), rien d'autre.
 *
 * L'air, en particules : froid l'été (glacier, l'air sort de l'appareil en haut, descend et
 * s'étale), chaud l'hiver (cuivre, l'air monte du bas et ondule), puis tout revient dans une
 * seule ligne : un seul appareil.
 *
 * API (window.QualiclimReversible) :
 *   monter(hote, options)  → { regler(p), pause(), reprise(), detruire() } ou null
 *       Monte la scène dans `hote` (l'élément .rev-scene). null si WebGL est indisponible,
 *       si l'appareil est trop modeste (palier D), ou en mouvement réduit.
 *       regler(p) : progression 0..1, pilotée de l'extérieur (ScrollTrigger). Ne rend rien
 *       par lui-même : la prochaine image de la boucle en tient compte.
 *   texte(section, options) → { regler(p), detruire() } ou null
 *       Pilote le texte de la scène (phrase active, consigne, saison, jauge). Indépendant de
 *       WebGL : il sert aussi quand monter() a renvoyé null. null en mouvement réduit.
 *   etat(p) → la chorégraphie de la §6.4 réduite à des nombres (pure, sans effet de bord).
 *
 * Principes (CLAUDE.md §4.4, mouvement.md §6.8) : le canvas est décoratif (aria-hidden,
 * pointer-events: none) ; il n'écoute ni la molette, ni le pointeur, ni un geste. Un seul appel
 * de dessin, aucune texture, aucun post-traitement. Tout le mouvement est calculé dans le
 * shader de sommets à partir d'une graine et du temps : le processeur ne change que quelques
 * uniformes par image. DPR ≤ 1,5, pixels plafonnés, pause hors écran, contexte perdu géré,
 * libération complète.
 */
(function () {
  'use strict';

  var NUIT = 0x0e1d33;
  var COULEURS = { froid: '#d8e4f2', froidVif: '#7ab6e8', chaud: '#b99167', chaudVif: '#f8dcb0' };
  var DPR_MAX = 1.5;
  var PIXELS_MAX = 2560 * 1440;
  var TEMPS_FIGE = 12;
  var GRAINE = 7;

  // ------------------------------------------------------------------ outils

  function borne(x, a, b) { return x < a ? a : x > b ? b : x; }
  function plage(p, a, b) { return borne((p - a) / (b - a), 0, 1); }
  // power2.inOut (GSAP), pour les courbes à l'intérieur du récit (§6.4)
  function p2(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
  // mulberry32 : tirage reproductible (graine 7), la même image à chaque capture
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function mouvementReduit() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  }
  function requete(q) {
    try { return window.matchMedia(q).matches; } catch (e) { return false; }
  }
  function ecouterMedia(mq, f) {
    if (!mq) return function () {};
    if (mq.addEventListener) { mq.addEventListener('change', f); return function () { mq.removeEventListener('change', f); }; }
    if (mq.addListener) { mq.addListener(f); return function () { mq.removeListener(f); }; }
    return function () {};
  }

  // ------------------------------------------------------------------ chorégraphie (§6.4)

  /**
   * La progression P de la scène épinglée réduite à des nombres. Le défilement est l'horloge :
   * P = 0 en haut de l'épinglage, 1 à sa fin. Aucune valeur n'est minutée.
   */
  function etat(p) {
    p = borne(+p || 0, 0, 1);
    var approche = p2(plage(p, 0, 0.30));
    var bascule = p2(plage(p, 0.30, 0.62));
    var unite = p2(plage(p, 0.80, 0.94));
    var t1 = p2(plage(p, 0.40, 0.52));   // « Froid l'été. » sort, « Chaud l'hiver. » entre
    var t2 = p2(plage(p, 0.80, 0.94));   // « Chaud l'hiver. » sort, « Un seul appareil. » entre
    return {
      p: p,
      saison: bascule,                                   // uSaison : 0 été → 1 hiver
      unite: unite,                                      // uUnite : 0 → 1, l'air revient dans la ligne
      camZ: 6 - 0.4 * approche + 0.3 * unite,            // 6,0 → 5,6 → 5,9
      camY: 0.15 - 0.30 * bascule,                       // +0,15 → −0,15
      consigne: 26 - Math.round(7 * plage(p, 0.36, 0.58)), // 26 → 19, par pas entiers, jamais minuté
      saisonActive: p >= 0.47 ? 'hiver' : 'ete',
      phrases: [-105 * t1, 105 * (1 - t1) - 105 * t2, 105 * (1 - t2)], // yPercent de chaque phrase
      phraseActive: p < 0.46 ? 0 : p < 0.87 ? 1 : 2,
      opaciteConsigne: 1 - 0.75 * unite,                 // la phrase porte le message à la fin
      jauge: bascule
    };
  }

  // ------------------------------------------------------------------ shaders

  var SOMMETS = [
    'uniform float uTemps, uSaison, uUnite, uTaille, uDpr, uAlphaLigne, uFilets, uDemiLigne, uLigneY;',
    'uniform float uTrace, uTraceMax, uMarge;',
    'uniform float uCalmeForce[6];',
    'uniform float uIntensite;',
    'uniform vec2 uEtendue, uResolution;',
    'uniform vec4 uCalme[6];',
    'uniform vec3 uFroid, uFroidVif, uChaud, uChaudVif;',
    'attribute vec4 aGraine;',
    'varying vec3 vCouleur;',
    'varying float vAlpha, vDemi, vRayon, vDoux;',
    'varying vec2 vDir;',
    '',
    '// Constantes de la particule (calculées une fois dans main, lues par les fonctions)',
    'float gX0, gPhase, gHiver;',
    '',
    '// Été : l\'air sort de l\'appareil (la ligne haute), descend en accélérant et s\'étale.',
    'vec2 airEte(float vie) {',
    '  float yL = uLigneY * uEtendue.y;',
    '  float etal = mix(uDemiLigne, uEtendue.x * 1.15, pow(vie, 0.8));',
    '  vec2 p = vec2(gX0 * etal, yL - (yL + uEtendue.y * 1.15) * pow(vie, 1.35));',
    '  p.x += sin(vie * 4.0 + gPhase + uTemps * 0.45) * 0.035 * vie * uEtendue.x;',
    '  return p;',
    '}',
    '// Hiver : l\'air monte du bas et ondule ; la vague est commune aux filets voisins (un rideau, pas des fils emmêlés).',
    'vec2 airHiver(float vie) {',
    '  float y = uEtendue.y * (-1.15 + 2.3 * vie);',
    '  float amp = 0.07 * uEtendue.y * (0.3 + vie);',
    '  float x = gX0 * uEtendue.x * (0.88 + 0.1 * vie) + sin(y * 1.35 - uTemps * 0.7 + gX0 * 2.2 + gPhase * 0.25) * amp;',
    '  return vec2(x, y);',
    '}',
    'vec2 air(float vie) { return gHiver > 0.5 ? airHiver(vie) : airEte(vie); }',
    '',
    'void main() {',
    '  gHiver = step(0.5, fract(aGraine.w * 7.31 + aGraine.z * 1.7)); // deux populations : été, hiver',
    '  float k = floor(uFilets * mix(1.0, 0.68, gHiver) + 0.5);  // l\'hiver : moins de filets, plus pleins',
    '  float filet = floor(aGraine.z * k);',
    '  float alea = fract(aGraine.y * 13.7 + aGraine.x * 3.1);',
    '  float dansFilet = step(0.3, alea);                       // 70 % en filets, 30 % en poussière d\'air',
    '  float eclat = fract(aGraine.w * 17.3 + aGraine.y * 5.1);',
    '  float bokeh = (1.0 - dansFilet) * step(0.94, fract(aGraine.w * 91.7 + aGraine.x * 3.3));',
    '  float force = mix(0.4, 1.0, pow(fract(sin(filet * 78.233 + gHiver * 3.1) * 43758.5453), 1.4)); // filets inégaux : de la profondeur',
    '  gX0 = mix(aGraine.z * 2.0 - 1.0, (filet + 0.5) / k * 2.0 - 1.0 + (aGraine.x - 0.5) * 0.014, dansFilet);',
    '  gPhase = mix(aGraine.w * 6.2831, gX0 * 2.0, dansFilet);',
    '  float vitesse = mix(mix(0.04, 0.10, aGraine.x), mix(0.05, 0.085, fract(filet * 0.37)), dansFilet);',
    '  vitesse *= mix(1.0, 0.45, bokeh);',
    '  float vie = fract(uTemps * vitesse + aGraine.y);         // naît, vit, renaît',
    '  float vieQ = max(vie - vitesse * uTrace, 0.0);           // la queue de la traînée',
    '  float z = (mix(fract(aGraine.x * 7.13 + aGraine.z), fract(filet * 0.618), dansFilet) * 2.4 - 1.2);',
    '  z = mix(z, 1.6 + aGraine.x * 0.9, bokeh);                // quelques poussières floues, tout près',
    '',
    '  vec2 pT = air(vie);',
    '  vec2 pQ = air(vieQ);',
    '',
    '  // La bascule : un front d\'air chaud monte du bas. Sous lui, l\'air froid s\'éteint et l\'air chaud',
    '  // s\'allume. Aucune particule ne glisse d\'une trajectoire à l\'autre.',
    '  float front = mix(-1.45, 1.25, uSaison) * uEtendue.y;   // traverse l\'écran entre P ≈ 0,39 et 0,54',
    '  front += (sin(pT.x * 1.6 + uTemps * 0.35) * 0.07 + sin(pT.x * 3.7 - uTemps * 0.2 + 1.3) * 0.035) * uEtendue.y; // un front vivant, pas une règle',
    '  float bord = 0.14 * uEtendue.y;',
    '  float visible = gHiver < 0.5 ? smoothstep(front - bord, front + bord, pT.y)',
    '                               : 1.0 - smoothstep(front - bord, front + bord, pT.y);',
    '',
    '  // Un seul appareil : tout revient dans la ligne d\'où sort l\'air d\'été ; elle coule lentement',
    '  // de gauche (glacier) à droite (cuivre) et respire.',
    '  float u = clamp(uUnite * 1.2 - aGraine.x * 0.2, 0.0, 1.0);',
    '  u = u * u * (3.0 - 2.0 * u);',
    '  float xl = fract(aGraine.z + uTemps * 0.012) * 2.0 - 1.0;',
    '  float ep = aGraine.y - 0.5;',
    '  ep = sign(ep) * pow(abs(ep) * 2.0, 2.4);',
    '  float respire = 1.0 + 0.004 * sin(uTemps * 0.9);',
    '  vec2 ligne = vec2(xl * uDemiLigne * respire, uLigneY * uEtendue.y + ep * 0.022 * (1.0 + 0.3 * sin(uTemps * 1.1)));',
    '  pT = mix(pT, ligne, u);',
    '  pQ = mix(pQ, ligne, u);',
    '  z *= 1.0 - u;',
    '',
    '  // Projection de la tête et de la queue : la traînée suit la vitesse réelle à l\'écran.',
    '  vec4 mvT = modelViewMatrix * vec4(pT, z, 1.0);',
    '  vec4 cT = projectionMatrix * mvT;',
    '  vec4 cQ = projectionMatrix * (modelViewMatrix * vec4(pQ, z, 1.0));',
    '  vec2 nT = cT.xy / cT.w;',
    '  vec2 nQ = cQ.xy / cQ.w;',
    '  vec2 dPx = (nT - nQ) * 0.5 * uResolution;',
    '  float L = min(length(dPx), uTraceMax);',
    '  vec2 dir = L > 0.05 ? normalize(dPx) : vec2(1.0, 0.0);',
    '',
    '  float persp = 6.0 / max(-mvT.z, 0.5);',
    '  float base = mix(mix(1.3, 2.5, aGraine.w), 1.9, dansFilet);',
    '  base = mix(base, mix(9.0, 16.0, aGraine.w), bokeh);',
    '  base *= mix(1.0, 1.2, gHiver * (1.0 - u));                // le cuivre, plus sombre, prend un peu de corps',
    '  float diam = max(uTaille * uDpr * base * persp, 1.5);',
    '  diam = min(diam, 30.0 * uDpr);',
    '  float S = min(L + diam + 2.0, 72.0);',
    '  L = max(S - diam - 2.0, 0.0);',
    '',
    '  // Opacité : vive à la sortie, douce à l\'extinction',
    '  float vieA = smoothstep(0.0, 0.05, vie) * (1.0 - smoothstep(0.55, 1.0, vie));',
    '  float a = vieA * mix(0.3, 0.62 * force, dansFilet) * visible;',
    '  a *= mix(1.0, 0.09, bokeh);',
    '  float sLigne = smoothstep(-0.35, 0.35, xl);',
    '  float s = mix(gHiver, sLigne, u);',
    '  a *= mix(1.0, 1.45, gHiver);',
    '  float aLigne = uAlphaLigne * (1.0 - smoothstep(0.78, 1.0, abs(xl))) * mix(1.0, 1.6, sLigne);',
    '  a = mix(a, aLigne, u);                                  // sur la ligne : jamais de blanc saturé',
    '  a *= mix(1.0, 0.75, smoothstep(6.0, 22.0, L));           // une traînée longue s\'étale : elle ne brille pas plus',
    '',
    '  // Zones calmes : derrière le petit texte, l\'air s\'efface (contraste garanti avec le voile CSS).',
    '  vec2 c = nT - dir * (L * 0.5) / (0.5 * uResolution);',
    '  vec2 px = (c * 0.5 + 0.5) * uResolution;',
    '  float calme = 0.0;',
    '  for (int i = 0; i < 6; i++) {',
    '    vec4 r = uCalme[i];',
    '    vec2 e = max(max(r.xy - px, px - r.zw), 0.0);',
    '    calme = max(calme, uCalmeForce[i] * (1.0 - smoothstep(0.0, uMarge, length(e))));',
    '  }',
    '  a *= 1.0 - calme;',
    '',
    '  if (a < 0.003) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vAlpha = 0.0; return; }',
    '',
    '  gl_Position = vec4(c, 0.0, 1.0);',
    '  gl_PointSize = S;',
    '  vDir = vec2(dir.x, -dir.y);                              // gl_PointCoord descend',
    '  vDemi = (L * 0.5) / S;',
    '  vRayon = (diam * 0.5) / S;',
    '  vDoux = mix(0.55, 0.98, bokeh);',
    '  vAlpha = a * uIntensite;',
    '  vCouleur = mix(mix(uFroid, uFroidVif, eclat), mix(uChaud, uChaudVif, eclat * 0.5), s);',
    '}'
  ].join('\n');

  var FRAGMENTS = [
    'varying vec3 vCouleur;',
    'varying float vAlpha, vDemi, vRayon, vDoux;',
    'varying vec2 vDir;',
    'void main() {',
    '  vec2 q = gl_PointCoord - 0.5;',
    '  float t = clamp(dot(q, vDir), -vDemi, vDemi);',
    '  float d = length(q - vDir * t);',
    '  float corps = 1.0 - smoothstep(vRayon * (1.0 - vDoux), vRayon, d);',
    '  if (corps < 0.004) discard;',
    '  float lg = 2.0 * vDemi;',
    '  float tete = lg > 0.002 ? (t + vDemi) / lg : 1.0;',
    '  float trace = mix(0.08, 1.0, tete * tete);                // tête vive, queue qui s\'efface',
    '  // Grain fixe à l\'écran : les particules traversent un grain de pellicule, il ne scintille pas.',
    '  float grain = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));',
    '  float a = vAlpha * corps * trace * (0.88 + 0.24 * grain);',
    '  gl_FragColor = vec4(vCouleur, a);',
    '}'
  ].join('\n');

  // ------------------------------------------------------------------ paliers (§6.8)

  function creerContexte(canvas, logiciel, capture) {
    var attributs = {
      alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: true,
      preserveDrawingBuffer: !!capture, powerPreference: 'default',
      failIfMajorPerformanceCaveat: !logiciel
    };
    var gl = null;
    try { gl = canvas.getContext('webgl2', attributs); } catch (e) { gl = null; }
    if (!gl) { try { gl = canvas.getContext('webgl', attributs) || canvas.getContext('experimental-webgl', attributs); } catch (e) { gl = null; } }
    return gl;
  }

  function choisirPalier(o, webgl2) {
    if (o.particules) return { nom: 'impose', particules: Math.max(1000, Math.min(40000, o.particules | 0)), cadence: o.cadence === 30 ? 30 : 60 };
    var nav = window.navigator || {};
    var memoire = nav.deviceMemory || 8;
    var coeurs = nav.hardwareConcurrency || 4;
    var largeur = window.innerWidth || 1024;
    var grossier = requete('(pointer: coarse)');
    var fin = requete('(pointer: fine)');
    if (grossier || largeur < 812 || coeurs <= 2) return { nom: 'C', particules: 6000, cadence: 30 };
    if (webgl2 && fin && largeur >= 1280 && coeurs >= 8 && memoire > 4) return { nom: 'A', particules: 24000, cadence: 60 };
    return { nom: 'B', particules: 12000, cadence: 60 };
  }

  function appareilModeste() {
    var nav = window.navigator || {};
    if (nav.connection && nav.connection.saveData) return true;
    if (nav.deviceMemory && nav.deviceMemory <= 2) return true;
    return false;
  }

  // ------------------------------------------------------------------ monter

  /**
   * options (toutes facultatives) :
   *   particules   nombre imposé (sinon palier A 24 000, B 12 000, C 6 000)
   *   cadence      30 ou 60, avec `particules`
   *   fige         temps figé à 12 s (par défaut : window.__fige)
   *   temps        temps figé à cette valeur (s), pour les contrôles
   *   logiciel     accepter un rendu WebGL logiciel (par défaut : seulement si figé)
   *   capture      preserveDrawingBuffer (image fixe de la scène)
   *   regulateur   false pour couper le régulateur de cadence (coupé d'office si figé)
   *   calme        éléments derrière lesquels l'air s'efface (par défaut : [data-rev-calme] de l'hôte, 6 au plus ;
   *                la valeur de l'attribut, 0..1, règle la force, 0,85 par défaut)
   *   intensite    0..1, l'air plus discret (1 par défaut ; l'image fixe est rendue à 0,7)
   *   forcer       monter même en mouvement réduit (image fixe de la scène uniquement)
   *   surPremiereImage(), surPerte(), surReprise(), surArret(raison)
   */
  function monter(hote, options) {
    var o = options || {};
    var THREE = window.THREE;
    if (!hote || !THREE || !THREE.WebGLRenderer) return null;
    if (!o.forcer && mouvementReduit()) return null;
    if (!o.particules && appareilModeste()) return null;

    var fige = o.temps != null || (o.fige != null ? !!o.fige : !!window.__fige);
    var tempsFige = o.temps != null ? +o.temps : TEMPS_FIGE;
    var logiciel = o.logiciel != null ? !!o.logiciel : fige;

    var canvas = document.createElement('canvas');
    canvas.className = 'rev-toile';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.setAttribute('role', 'presentation');
    var gl = creerContexte(canvas, logiciel, o.capture);
    if (!gl) return null;
    var webgl2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
    var palier = choisirPalier(o, webgl2);

    var renderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas: canvas, context: gl, antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'default', preserveDrawingBuffer: !!o.capture });
    } catch (e) {
      var perte = gl.getExtension && gl.getExtension('WEBGL_lose_context');
      if (perte) perte.loseContext();
      return null;
    }
    renderer.setClearColor(NUIT, 1);

    var scene = new THREE.Scene();
    var camera = new THREE.PerspectiveCamera(35, 1, 0.1, 20);
    camera.position.set(0, 0.15, 6);

    var calmes = [], forces = [];
    for (var ci = 0; ci < 6; ci++) { calmes.push(new THREE.Vector4(-1e5, -1e5, -1e5, -1e5)); forces.push(0); }
    var uniformes = {
      uTemps: { value: fige ? tempsFige : 0 },
      uIntensite: { value: o.intensite != null ? borne(+o.intensite || 0, 0, 1) : 1 },
      uSaison: { value: 0 },
      uUnite: { value: 0 },
      uTaille: { value: 1.3 },
      uDpr: { value: 1 },
      uAlphaLigne: { value: 0.1 },
      uFilets: { value: 34 },
      uDemiLigne: { value: 1 },
      uLigneY: { value: 0.5 },
      uTrace: { value: 0.42 },
      uTraceMax: { value: 30 },
      uMarge: { value: 36 },
      uCalmeForce: { value: forces },
      uEtendue: { value: new THREE.Vector2(3, 1.892) },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uCalme: { value: calmes },
      uFroid: { value: new THREE.Color(COULEURS.froid) },
      uFroidVif: { value: new THREE.Color(COULEURS.froidVif) },
      uChaud: { value: new THREE.Color(COULEURS.chaud) },
      uChaudVif: { value: new THREE.Color(COULEURS.chaudVif) }
    };

    var geometrie = null, materiau = null, points = null;
    var nombre = palier.particules, dessinees = nombre;

    function construire() {
      geometrie = new THREE.BufferGeometry();
      // `position` n'est lue par aucun shader : three r128 en tire seulement le nombre de sommets.
      geometrie.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nombre), 1));
      var graines = new Float32Array(nombre * 4);
      var tirage = mulberry32(GRAINE);
      for (var i = 0; i < graines.length; i++) graines[i] = tirage();
      geometrie.setAttribute('aGraine', new THREE.BufferAttribute(graines, 4));
      geometrie.setDrawRange(0, dessinees);
      materiau = new THREE.ShaderMaterial({
        vertexShader: SOMMETS, fragmentShader: FRAGMENTS, uniforms: uniformes,
        transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending
      });
      points = new THREE.Points(geometrie, materiau);
      points.frustumCulled = false;
      scene.add(points);
    }
    function demolir() {
      if (points) scene.remove(points);
      if (geometrie) geometrie.dispose();
      if (materiau) materiau.dispose();
      points = geometrie = materiau = null;
    }
    construire();

    // Le canvas se pose au-dessus de l'image fixe (.rev-affiche), sous le voile et le texte.
    var affiche = hote.querySelector('.rev-affiche');
    if (affiche && affiche.parentNode === hote) hote.insertBefore(canvas, affiche.nextSibling);
    else hote.insertBefore(canvas, hote.firstChild);

    // ---------------------------------------------------------------- dimensions

    var dprCourant = DPR_MAX, niveau = 0, facteurY = 1;
    var tampon = new THREE.Vector2();

    function elementsCalmes() {
      var liste = o.calme ? Array.prototype.slice.call(o.calme) : Array.prototype.slice.call(hote.querySelectorAll('[data-rev-calme]'));
      return liste.slice(0, 6);
    }
    var aCalmer = elementsCalmes();

    function mesurerCalme() {
      var c = canvas.getBoundingClientRect();
      if (!c.width || !c.height) return;
      var sx = tampon.x / c.width, sy = tampon.y / c.height;
      for (var i = 0; i < 6; i++) {
        var el = aCalmer[i];
        var r = el && el.getClientRects().length ? el.getBoundingClientRect() : null;
        if (!r || !r.width || !r.height) { calmes[i].set(-1e5, -1e5, -1e5, -1e5); forces[i] = 0; continue; }
        // En largeur, l'étendue réelle du texte (une phrase courte ne calme pas toute la ligne)
        var gauche = r.left, droite = r.right;
        try {
          var plageTexte = document.createRange();
          plageTexte.selectNodeContents(el);
          var t = plageTexte.getBoundingClientRect();
          if (t.width > 0) { gauche = Math.max(r.left, t.left); droite = Math.min(r.right, t.right); }
          if (droite <= gauche) { gauche = r.left; droite = r.right; }
        } catch (er) { /* rectangle de l'élément */ }
        var f = parseFloat(el.getAttribute('data-rev-calme'));
        forces[i] = isNaN(f) ? 0.85 : borne(f, 0, 1);
        // pixels du tampon, origine en bas à gauche (comme gl_Position)
        calmes[i].set((gauche - c.left) * sx, (c.bottom - r.bottom) * sy, (droite - c.left) * sx, (c.bottom - r.top) * sy);
      }
    }

    function dimensionner() {
      var w = Math.max(1, hote.clientWidth), h = Math.max(1, hote.clientHeight);
      var dpr = Math.min(DPR_MAX, window.devicePixelRatio || 1, niveau >= 1 ? 1 : DPR_MAX);
      if (w * h * dpr * dpr > PIXELS_MAX) dpr = Math.sqrt(PIXELS_MAX / (w * h));
      dprCourant = dpr;
      renderer.setPixelRatio(dpr);
      renderer.setSize(w, h, false);
      renderer.getDrawingBufferSize(tampon);
      var aspect = w / h;
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
      var e = Math.tan(17.5 * Math.PI / 180) * 6;           // demi-hauteur visible à z = 0
      uniformes.uEtendue.value.set(e * aspect, e);
      uniformes.uResolution.value.set(tampon.x, tampon.y);
      uniformes.uFilets.value = Math.round(Math.min(34, Math.max(14, 34 * aspect / 1.6)));
      // La ligne de l'appareil : plus longue en portrait, plus basse pour laisser la consigne respirer
      var portrait = borne((aspect - 0.6) / 1.0, 0, 1);
      uniformes.uDemiLigne.value = e * aspect * (0.62 + (0.32 - 0.62) * portrait);
      uniformes.uLigneY.value = 0.25 + 0.11 * portrait;
      facteurY = borne(aspect, 0.45, 1);                     // en portrait, la caméra glisse moins
      uniformes.uAlphaLigne.value = Math.min(0.24, Math.max(0.02, 2.3 * (w * 0.42) / dessinees));
      uniformes.uTaille.value = w < 812 ? 1.15 : 1.3;
      uniformes.uDpr.value = dpr;
      uniformes.uTraceMax.value = 38 * dpr;
      uniformes.uMarge.value = 40 * dpr;
      mesurerCalme();
      demander();
    }

    // ---------------------------------------------------------------- état et boucle

    var etatCourant = etat(0);
    var detruit = false, enPause = false, horsEcran = !('IntersectionObserver' in window) ? false : true, perdu = false, arrete = false;
    var raf = 0, derniere = 0, temps = 0, saute = false, images = 0, premiere = true, demandeUnique = false;
    var echantillons = [], ignorees = 0;
    var regule = o.regulateur !== false && !fige;

    function actif() { return !detruit && !enPause && !horsEcran && !perdu && !arrete && !document.hidden; }

    function rendre() {
      var e = etatCourant;
      uniformes.uTemps.value = fige ? tempsFige : temps;
      uniformes.uSaison.value = e.saison;
      uniformes.uUnite.value = e.unite;
      camera.position.set(0, e.camY * facteurY, e.camZ);
      renderer.render(scene, camera);
      images++;
      if (premiere) {
        premiere = false;
        canvas.classList.remove('rev-toile--perdue');
        canvas.classList.add('rev-toile--prete');
        hote.classList.add('rev--webgl');
        if (o.surPremiereImage) try { o.surPremiereImage(); } catch (er) { /* rien */ }
      }
    }

    function regulateur(dt) {
      if (!regule || dt <= 0) return;
      if (ignorees < 12) { ignorees++; return; }           // compilation des shaders, premier rendu
      echantillons.push(dt * 1000);
      if (echantillons.length < 90) return;
      var tri = echantillons.slice().sort(function (a, b) { return a - b; });
      var p25 = tri[Math.floor(tri.length * 0.25)], p75 = tri[Math.floor(tri.length * 0.75)];
      echantillons = []; ignorees = 0;
      if (p75 <= 24) { regule = false; return; }            // l'appareil tient : on ne mesure plus
      // Cadence régulière à 30 i/s (économie d'énergie du système, écran à 30 Hz) : ce n'est pas
      // une surcharge, l'air est lent, on garde la scène telle quelle.
      if (p75 - p25 < 4 && p75 <= 35) { regule = false; return; }
      if (p75 > 34) { arreter('lent'); return; }
      niveau++;
      if (niveau === 1 && dprCourant > 1) { dimensionner(); return; }
      if (niveau <= 2 && dessinees === nombre) {
        niveau = 2;
        dessinees = Math.floor(nombre / 2);
        if (geometrie) geometrie.setDrawRange(0, dessinees);
        dimensionner();
        return;
      }
      arreter('lent');
    }

    function boucle(t) {
      raf = 0;
      if (!actif()) { derniere = 0; return; }
      raf = requestAnimationFrame(boucle);
      var dt = derniere ? (t - derniere) / 1000 : 0;
      derniere = t;
      temps += Math.min(dt, 0.1);
      regulateur(dt);
      if (!actif()) return;
      if (palier.cadence === 30) { saute = !saute; if (saute && !demandeUnique && !premiere) return; }
      demandeUnique = false;
      rendre();
    }

    function relancer() {
      if (actif() && !raf) { derniere = 0; raf = requestAnimationFrame(boucle); }
      if (!actif() && raf) { cancelAnimationFrame(raf); raf = 0; derniere = 0; }
    }
    function demander() { demandeUnique = true; relancer(); }

    function arreter(raison) {
      arrete = true;
      relancer();
      canvas.classList.remove('rev-toile--prete');
      hote.classList.remove('rev--webgl');
      if (o.surArret) try { o.surArret(raison); } catch (er) { /* rien */ }
    }

    // ---------------------------------------------------------------- écouteurs (aucun sur la molette ni le pointeur)

    var io = null, ro = null, desabonnements = [];
    if ('IntersectionObserver' in window) {
      io = new IntersectionObserver(function (entrees) {
        var e = entrees[entrees.length - 1];
        horsEcran = !e.isIntersecting;
        relancer();
      }, { rootMargin: '10% 0px' });
      io.observe(hote);
    }
    if ('ResizeObserver' in window) {
      var attente = 0;
      ro = new ResizeObserver(function () {
        if (attente) return;
        attente = requestAnimationFrame(function () { attente = 0; if (!detruit) dimensionner(); });
      });
      ro.observe(hote);
      aCalmer.forEach(function (el) { ro.observe(el); });
    } else {
      var surRedim = function () { dimensionner(); };
      window.addEventListener('resize', surRedim);
      desabonnements.push(function () { window.removeEventListener('resize', surRedim); });
    }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { if (!detruit) mesurerCalme(); });

    function surVisibilite() { relancer(); }
    document.addEventListener('visibilitychange', surVisibilite);
    desabonnements.push(function () { document.removeEventListener('visibilitychange', surVisibilite); });

    function surDepart(e) { if (!e.persisted) detruire(); }
    window.addEventListener('pagehide', surDepart);
    desabonnements.push(function () { window.removeEventListener('pagehide', surDepart); });

    if (!o.forcer) {
      var mq = null;
      try { mq = window.matchMedia('(prefers-reduced-motion: reduce)'); } catch (e) { mq = null; }
      desabonnements.push(ecouterMedia(mq, function (e) {
        if (e.matches) { detruire(); if (o.surArret) try { o.surArret('mouvement-reduit'); } catch (er) { /* rien */ } }
      }));
    }

    function surPerte(e) {
      e.preventDefault();                                  // demande la restauration
      perdu = true;
      relancer();
      canvas.classList.remove('rev-toile--prete');
      canvas.classList.add('rev-toile--perdue');
      hote.classList.remove('rev--webgl');
      if (o.surPerte) try { o.surPerte(); } catch (er) { /* rien */ }
    }
    function surRestauration() {
      if (detruit) return;
      // three r128 a déjà recréé son état GL : on rebâtit géométrie et matériau, puis on reprend.
      if (points) scene.remove(points);
      points = geometrie = materiau = null;                 // les anciens tampons appartiennent au contexte perdu
      construire();
      renderer.setClearColor(NUIT, 1);                     // le fond est remis à zéro par three
      perdu = false;
      premiere = true;
      dimensionner();
      if (o.surReprise) try { o.surReprise(); } catch (er) { /* rien */ }
    }
    canvas.addEventListener('webglcontextlost', surPerte, false);
    canvas.addEventListener('webglcontextrestored', surRestauration, false);

    // ---------------------------------------------------------------- API

    function detruire() {
      if (detruit) return;
      detruit = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      if (io) io.disconnect();
      if (ro) ro.disconnect();
      desabonnements.forEach(function (f) { f(); });
      canvas.removeEventListener('webglcontextlost', surPerte, false);
      canvas.removeEventListener('webglcontextrestored', surRestauration, false);
      demolir();
      renderer.dispose();
      try { renderer.forceContextLoss(); } catch (e) { /* déjà perdu */ }
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      hote.classList.remove('rev--webgl');
      renderer = null;
    }

    dimensionner();

    var instance = {
      regler: function (p) {
        if (detruit) return;
        etatCourant = etat(p);
        if (palier.cadence === 30) demandeUnique = true;  // au doigt, la réponse au défilement n'attend pas une image
      },
      pause: function () { enPause = true; relancer(); },
      reprise: function () { if (detruit) return; enPause = false; relancer(); },
      detruire: detruire
    };
    // Lecture seule, pour les contrôles et le banc : rien ne s'y règle.
    Object.defineProperty(instance, 'images', { get: function () { return images; } });
    Object.defineProperty(instance, 'palier', { get: function () { return palier.nom; } });
    Object.defineProperty(instance, 'particules', { get: function () { return dessinees; } });
    Object.defineProperty(instance, 'dpr', { get: function () { return dprCourant; } });
    Object.defineProperty(instance, 'enMarche', { get: function () { return !!raf; } });
    return instance;
  }

  // ------------------------------------------------------------------ texte de la scène

  /**
   * Pilote le texte de la section : phrase active (masque), consigne en entiers, saison,
   * jauge. Sans lui (sans JavaScript, mouvement réduit), la section reste dans sa forme
   * statique : trois phrases empilées, deux consignes côte à côte.
   */
  function texte(section, options) {
    var o = options || {};
    if (!section) return null;
    if (!o.forcer && mouvementReduit()) return null;
    var phrases = Array.prototype.slice.call(section.querySelectorAll('.rev-temps > li'));
    var nombre = section.querySelector('.rev-nombre');
    var consigne = section.querySelector('.rev-valeur');
    var saisons = Array.prototype.slice.call(section.querySelectorAll('.rev-saisons [data-saison]'));
    var point = section.querySelector('.rev-jauge b');
    var dernier = { consigne: null, saison: null, active: null };

    section.classList.add('rev--vivant');

    function regler(p) {
      var e = etat(p);
      for (var i = 0; i < phrases.length && i < 3; i++) {
        var y = e.phrases[i];
        // hors du masque, la phrase reste dans l'arbre d'accessibilité : les trois se lisent toujours
        phrases[i].style.transform = 'translate3d(0,' + y.toFixed(2) + '%,0)';
      }
      if (nombre && e.consigne !== dernier.consigne) { nombre.textContent = String(e.consigne); dernier.consigne = e.consigne; }
      if (consigne) consigne.style.opacity = e.opaciteConsigne.toFixed(3);
      if (e.saisonActive !== dernier.saison) {
        saisons.forEach(function (s) { s.classList.toggle('est-active', s.getAttribute('data-saison') === e.saisonActive); });
        dernier.saison = e.saisonActive;
      }
      if (point) point.style.transform = 'translate3d(' + (e.jauge * 100).toFixed(2) + '%,0,0)';
      if (e.phraseActive !== dernier.active) { section.setAttribute('data-rev-temps', String(e.phraseActive)); dernier.active = e.phraseActive; }
    }

    var arreter = function () {};
    if (!o.forcer) {
      var mq = null;
      try { mq = window.matchMedia('(prefers-reduced-motion: reduce)'); } catch (e) { mq = null; }
      arreter = ecouterMedia(mq, function (e) { if (e.matches) detruire(); });
    }

    function detruire() {
      arreter();
      section.classList.remove('rev--vivant');
      section.removeAttribute('data-rev-temps');
      phrases.forEach(function (li) { li.style.transform = ''; });
      if (consigne) consigne.style.opacity = '';
      if (nombre) nombre.textContent = '26';
      saisons.forEach(function (s) { s.classList.toggle('est-active', s.getAttribute('data-saison') === 'ete'); });
      if (point) point.style.transform = '';
    }

    regler(0);
    return { regler: regler, detruire: detruire };
  }

  window.QualiclimReversible = { monter: monter, texte: texte, etat: etat, version: '1.0.0' };
})();
