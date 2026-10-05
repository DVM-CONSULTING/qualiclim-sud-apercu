/*!
 * Qualiclim Sud — la pièce en 3D du simulateur. Dépend de window.THREE (three.js r128).
 * La pièce se construit pendant que le visiteur répond : surface, hauteur sous plafond, exposition,
 * baies vitrées, puissance (le souffle), besoin (froid, chaud ou les deux), emplacement de l'unité
 * extérieure et longueur de la liaison. Décoratif : le canvas est aria-hidden, le résultat est écrit en texte.
 *
 * API : QualiclimPiece.monter(hote) → { regler(etat), vue(nom), detruire() } | null
 *   etat = { surface, hauteur, exposition, baies, besoin, kw, emplacement, distance }
 *   vue('piece' | 'installation')
 */
(function () {
  'use strict';
  function webglDispo() { try { var c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch (e) { return false; } }

  function monter(hote) {
    var THREE = window.THREE;
    if (!hote || !THREE || !webglDispo()) return null;
    var reduit = matchMedia('(prefers-reduced-motion: reduce)').matches;
    var fin = matchMedia('(pointer: fine)').matches;

    var rendu = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    rendu.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    rendu.outputEncoding = THREE.sRGBEncoding;
    rendu.toneMapping = THREE.ACESFilmicToneMapping; rendu.toneMappingExposure = 1.05;
    rendu.shadowMap.enabled = true; rendu.shadowMap.type = THREE.PCFSoftShadowMap;
    var canvas = rendu.domElement; canvas.className = 'piece-toile'; canvas.setAttribute('aria-hidden', 'true');
    hote.insertBefore(canvas, hote.firstChild);

    var scene = new THREE.Scene();
    var camera = new THREE.PerspectiveCamera(30, 1, 0.1, 200);
    var C = function (h) { return new THREE.Color(h); };

    // Lumières : ciel argent, sol nuit, soleil par la fenêtre
    scene.add(new THREE.HemisphereLight(0xf4f2ee, 0x0e1d33, 0.75));
    var soleil = new THREE.DirectionalLight(0xffe2bf, 1.4);
    soleil.castShadow = true; soleil.shadow.mapSize.set(1024, 1024); soleil.shadow.bias = -0.0008;
    soleil.shadow.camera.left = -8; soleil.shadow.camera.right = 8; soleil.shadow.camera.top = 8; soleil.shadow.camera.bottom = -8;
    scene.add(soleil); scene.add(soleil.target);
    var douce = new THREE.DirectionalLight(0xd8e4f2, 0.35); douce.position.set(6, 8, 10); scene.add(douce);

    var mat = function (c, r) { return new THREE.MeshStandardMaterial({ color: c, roughness: r == null ? 0.92 : r, metalness: 0 }); };
    var BOITE = new THREE.BoxGeometry(1, 1, 1);
    function boite(m, ombre) { var b = new THREE.Mesh(BOITE, m); b.castShadow = !!ombre; b.receiveShadow = true; return b; }

    // Socle (ombre portée douce sous la pièce)
    var socleTex = (function () { var c = document.createElement('canvas'); c.width = c.height = 128; var x = c.getContext('2d');
      var g = x.createRadialGradient(64, 64, 10, 64, 64, 64); g.addColorStop(0, 'rgba(0,0,0,.55)'); g.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = g; x.fillRect(0, 0, 128, 128);
      return new THREE.CanvasTexture(c); })();
    var socle = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: socleTex, transparent: true, depthWrite: false }));
    socle.rotation.x = -Math.PI / 2; socle.position.y = -0.09; scene.add(socle);

    // Sol : parquet clair dessiné, lames de 20 cm
    var parquet = (function () { var c = document.createElement('canvas'); c.width = 512; c.height = 512; var x = c.getContext('2d');
      x.fillStyle = '#e4d9c6'; x.fillRect(0, 0, 512, 512);
      for (var r = 0; r < 16; r++) { var dec = (r % 3) * 120; for (var k = -1; k < 4; k++) { var t = 222 - ((r * 7 + k * 13) % 5) * 6;
        x.fillStyle = 'rgb(' + t + ',' + (t - 10) + ',' + (t - 28) + ')'; x.fillRect(k * 170 + dec, r * 32 + 1, 168, 30); } }
      var tx = new THREE.CanvasTexture(c); tx.wrapS = tx.wrapT = THREE.RepeatWrapping; tx.encoding = THREE.sRGBEncoding; tx.anisotropy = 8; return tx; })();
    var matSol = new THREE.MeshStandardMaterial({ map: parquet, roughness: 0.8 });
    var sol = boite(matSol); scene.add(sol);
    var murFond = boite(mat('#f4f2ee')), murGauche = boite(mat('#ebe6dc'));
    scene.add(murFond, murGauche);
    var plinthes = [boite(mat('#d9d5cd')), boite(mat('#d9d5cd'))]; plinthes.forEach(function (p) { scene.add(p); });

    // Fenêtre (mur de gauche) : cadre nuit, vitre glacier, tache de soleil au sol
    var cadre = boite(mat('#0e1d33', 0.5)), vitre = new THREE.Mesh(BOITE, new THREE.MeshStandardMaterial({ color: '#bcd3ec', roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.55, emissive: '#8fb3dc', emissiveIntensity: 0.35 }));
    scene.add(cadre, vitre);
    var tacheTex = (function () { var c = document.createElement('canvas'); c.width = 64; c.height = 64; var x = c.getContext('2d');
      var g = x.createLinearGradient(0, 0, 64, 0); g.addColorStop(0, 'rgba(255,214,160,.0)'); g.addColorStop(.25, 'rgba(255,214,160,.85)'); g.addColorStop(1, 'rgba(255,214,160,0)');
      x.fillStyle = g; x.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c); })();
    var tache = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: tacheTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.5 }));
    tache.rotation.x = -Math.PI / 2; scene.add(tache);

    // Mobilier (échelle humaine) : canapé nuit, table basse, plante
    var tissu = mat('#1f3354', 0.95), bois = mat('#b99167', 0.7), blanc = mat('#f7f6f2', 0.6);
    var canape = new THREE.Group();
    [[2.0, 0.42, 0.9, 0, 0.21, 0], [2.0, 0.5, 0.2, 0, 0.62, -0.35], [0.18, 0.6, 0.9, -0.91, 0.3, 0], [0.18, 0.6, 0.9, 0.91, 0.3, 0]].forEach(function (d) {
      var b = boite(tissu, true); b.scale.set(d[0], d[1], d[2]); b.position.set(d[3], d[4], d[5]); canape.add(b); });
    scene.add(canape);
    var table = new THREE.Group(); var plateau = boite(bois, true); plateau.scale.set(0.9, 0.05, 0.55); plateau.position.y = 0.4; table.add(plateau);
    [[-0.38, -0.22], [0.38, -0.22], [-0.38, 0.22], [0.38, 0.22]].forEach(function (q) { var p = boite(bois, true); p.scale.set(0.04, 0.38, 0.04); p.position.set(q[0], 0.19, q[1]); table.add(p); });
    scene.add(table);
    var plante = new THREE.Group(); var pot = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.13, 0.36, 24), blanc); pot.position.y = 0.18; pot.castShadow = true; plante.add(pot);
    var feuilles = new THREE.Mesh(new THREE.IcosahedronGeometry(0.36, 1), new THREE.MeshStandardMaterial({ color: '#3f6b4f', roughness: 0.9, flatShading: true })); feuilles.position.y = 0.68; feuilles.scale.set(1, 1.35, 1); feuilles.castShadow = true; plante.add(feuilles);
    scene.add(plante);

    // Unité intérieure murale : profil arrondi extrudé, liseré cuivre, voyant
    function profilArrondi(l, h, r) { var s = new THREE.Shape(); s.moveTo(-l / 2 + r, -h / 2); s.lineTo(l / 2 - r, -h / 2); s.quadraticCurveTo(l / 2, -h / 2, l / 2, -h / 2 + r);
      s.lineTo(l / 2, h / 2 - r); s.quadraticCurveTo(l / 2, h / 2, l / 2 - r, h / 2); s.lineTo(-l / 2 + r, h / 2); s.quadraticCurveTo(-l / 2, h / 2, -l / 2, h / 2 - r);
      s.lineTo(-l / 2, -h / 2 + r); s.quadraticCurveTo(-l / 2, -h / 2, -l / 2 + r, -h / 2); return s; }
    var ui = new THREE.Group();
    var corps = new THREE.Mesh(new THREE.ExtrudeGeometry(profilArrondi(0.24, 0.3, 0.09), { depth: 0.92, bevelEnabled: false, curveSegments: 10 }), mat('#fbfaf7', 0.35));
    corps.rotation.y = Math.PI / 2; corps.position.x = -0.46; corps.castShadow = true; ui.add(corps);
    var liseré = boite(new THREE.MeshStandardMaterial({ color: '#c08a5b', roughness: 0.3, metalness: 0.6 })); liseré.scale.set(0.9, 0.012, 0.01); liseré.position.set(0, -0.1, 0.125); ui.add(liseré);
    var voyant = new THREE.Mesh(new THREE.SphereGeometry(0.012, 12, 12), new THREE.MeshBasicMaterial({ color: '#8ec5ff' })); voyant.position.set(0.36, -0.05, 0.123); ui.add(voyant);
    scene.add(ui);

    // Unité extérieure + liaison frigorifique
    var ue = new THREE.Group();
    var caisse = boite(mat('#e9e6e0', 0.55), true); caisse.scale.set(0.82, 0.6, 0.3); caisse.position.y = 0.3; ue.add(caisse);
    var grille = new THREE.Mesh(new THREE.CircleGeometry(0.2, 40), mat('#2a3242', 0.9)); grille.position.set(-0.13, 0.3, 0.151); ue.add(grille);
    var helice = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.012, 8, 40), mat('#9aa3b2', 0.4)); helice.position.set(-0.13, 0.3, 0.152); ue.add(helice);
    var pied = boite(mat('#0e1d33', 0.6)); pied.scale.set(0.9, 0.06, 0.4); pied.position.y = 0.03; ue.add(pied);
    scene.add(ue);
    var facade = boite(mat('#d9d4ca')), dalle = boite(mat('#c9c3b8')), coupe = boite(mat('#cfc9bf'));
    scene.add(facade, dalle, coupe);
    var matTube = new THREE.MeshStandardMaterial({ color: '#c08a5b', roughness: 0.35, metalness: 0.7 });
    var tube = null;

    // Souffle : particules calculées dans le shader de sommets
    var N = reduit ? 0 : (fin ? 7000 : 3500);
    var graine = new Float32Array(N * 4); for (var i = 0; i < graine.length; i++) graine[i] = Math.random();
    var gp = new THREE.BufferGeometry(); gp.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3)); gp.setAttribute('graine', new THREE.BufferAttribute(graine, 4));
    var Up = { uTemps: { value: 0 }, uOrigine: { value: new THREE.Vector3() }, uForce: { value: 0.4 }, uFroid: { value: 1 }, uTaille: { value: 46 * Math.min(window.devicePixelRatio || 1, 1.5) }, uPiece: { value: new THREE.Vector3(4, 2.5, 4) }, uActif: { value: 0.4 } };
    var souffle = new THREE.Points(gp, new THREE.ShaderMaterial({
      uniforms: Up, transparent: true, depthWrite: false, blending: THREE.NormalBlending,
      vertexShader: [
        'attribute vec4 graine; uniform float uTemps, uForce, uFroid, uTaille, uActif; uniform vec3 uOrigine, uPiece; varying float vA; varying vec3 vC;',
        'void main(){',
        '  float v = .16 + .1*graine.x + .12*uForce;',
        '  float t = fract(uTemps*v + graine.y);',
        '  float portee = uPiece.z*(.55 + .4*uForce);',
        '  vec3 p = uOrigine + vec3((graine.z - .5)*.8, -.06, .05);',
        '  p.z += t*portee;',
        '  p.x += (graine.z - .5)*t*uPiece.x*.7 + sin(t*6.28 + graine.w*12. + uTemps)*.06;',
        '  float yF = uOrigine.y - t*t*(uOrigine.y - .1)*(.75 + .3*graine.w);',
        '  float yC = uOrigine.y - uOrigine.y*.72*sin(3.14159*t)*(1. - .35*t);',
        '  p.y = mix(yC, yF, uFroid);',
        '  p.x = clamp(p.x, -uPiece.x*.5 + .05, uPiece.x*.5 - .05); p.z = clamp(p.z, -uPiece.z*.5 + .05, uPiece.z*.5 - .05); p.y = clamp(p.y, .03, uPiece.y - .04);',
        '  vec4 mv = modelViewMatrix * vec4(p, 1.);',
        '  gl_PointSize = uTaille*(.35 + .9*graine.w)/-mv.z;',
        '  gl_Position = projectionMatrix * mv;',
        '  vA = sin(3.14159*t)*(.35 + .45*uForce)*step(graine.x, uActif);',
        '  vC = mix(vec3(.88, .45, .16), vec3(.16, .5, .9), uFroid);',
        '}'].join('\n'),
      fragmentShader: 'varying float vA; varying vec3 vC; void main(){ float d = length(gl_PointCoord - .5); float a = vA*smoothstep(.5, .1, d); if (a < .01) discard; gl_FragColor = vec4(vC, a); }'
    }));
    souffle.frustumCulled = false; scene.add(souffle);

    // État animé (valeurs courantes → cibles)
    var cur = { W: 4.6, D: 4.2, H: 2.5, baies: 0, soleil: 0.8, angle: 0.6, froid: 1, force: 0.4, actif: 0.4, ueY: 0, dist: 3, vue: 0 };
    var cib = Object.assign({}, cur);
    var besoin = 'froid', tempsBesoin = 0, emplacement = 'sol';
    var EXPO = { nord: { s: 0.25, a: 1.2 }, est: { s: 0.65, a: 0.35 }, sud: { s: 1.0, a: 0.85 }, ouest: { s: 0.85, a: 1.35 } };

    function regler(e) {
      e = e || {};
      var s = Math.max(6, Math.min(80, e.surface || 25));
      var ratio = 1.15; cib.W = Math.sqrt(s * ratio); cib.D = s / cib.W;
      cib.H = Math.max(2.3, Math.min(3.6, e.hauteur || 2.5));
      cib.baies = e.baies ? 1 : 0;
      var x = EXPO[e.exposition] || EXPO.est; cib.soleil = x.s; cib.angle = x.a;
      var kw = Math.max(0.5, Math.min(9, e.kw || 2.5)); cib.force = Math.min(1, kw / 6); cib.actif = Math.min(1, 0.25 + kw / 7);
      besoin = e.besoin || 'les_deux';
      emplacement = e.emplacement || 'sol'; cib.dist = Math.max(1, Math.min(15, e.distance || 3));
      demander();
    }
    function vue(nom) { cib.vue = nom === 'installation' ? 1 : 0; demander(); }

    var w = 1, h = 1;
    function taille() { var r = hote.getBoundingClientRect(); w = Math.max(1, r.width | 0); h = Math.max(1, r.height | 0); rendu.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); demander(); }

    function poser() {
      var W = cur.W, D = cur.D, H = cur.H, ep = 0.12;
      sol.scale.set(W, 0.08, D); sol.position.set(0, -0.04, 0); parquet.repeat.set(W / 3.2, D / 3.2);
      socle.scale.set(W * 2.1, D * 2.1, 1);
      murFond.scale.set(W + ep, H, ep); murFond.position.set(ep / 2 * -1 + 0, H / 2, -D / 2 - ep / 2);
      murGauche.scale.set(ep, H, D); murGauche.position.set(-W / 2 - ep / 2, H / 2, 0);
      plinthes[0].scale.set(W, 0.08, 0.02); plinthes[0].position.set(0, 0.04, -D / 2 + 0.01);
      plinthes[1].scale.set(0.02, 0.08, D); plinthes[1].position.set(-W / 2 + 0.01, 0.04, 0);
      // Fenêtre : petite, ou grande baie si cochée
      var fh = 1.2 + (H - 1.45) * cur.baies, fl = Math.min(D * 0.62, 1.1 + 1.6 * cur.baies), fy = 0.95 + (fh / 2 - 0.95 + 0.06) * cur.baies + (1 - cur.baies) * 0.55;
      fy = cur.baies > 0.5 ? fh / 2 + 0.06 : 1.55;
      cadre.scale.set(0.05, fh + 0.08, fl + 0.08); cadre.position.set(-W / 2 + 0.005, fy, -D * 0.12);
      vitre.scale.set(0.06, fh, fl); vitre.position.set(-W / 2 + 0.01, fy, -D * 0.12);
      // Soleil : direction selon l'exposition, intensité selon le soleil reçu
      var a = cur.angle; soleil.position.set(-W / 2 - 6, 4.2 + 2 * (1 - cur.soleil), -D * 0.12 + Math.cos(a) * 4); soleil.target.position.set(0, 0, -D * 0.12 + Math.cos(a) * 0.5);
      soleil.intensity = 0.35 + 1.25 * cur.soleil;
      tache.scale.set(Math.min(W * 0.7, 1.4 + 1.8 * cur.baies + 1.2 * cur.soleil), fl * 0.95, 1); tache.position.set(-W / 2 + tache.scale.x / 2 + 0.05, 0.006, -D * 0.12 + Math.cos(a) * 0.3);
      tache.material.opacity = 0.15 + 0.55 * cur.soleil * (0.5 + 0.5 * cur.baies);
      // Mobilier
      canape.position.set(W / 2 - 1.3, 0, -D / 2 + 0.62); canape.rotation.y = 0;
      table.position.set(W / 2 - 1.3, 0, -D / 2 + 1.75);
      plante.position.set(-W / 2 + 0.45, 0, D / 2 - 0.5);
      // Unité intérieure : mur du fond, côté droit, sous le plafond
      var ux = W / 2 - 1.25, uy = H - 0.42; ui.position.set(ux, uy, -D / 2 + 0.13);
      Up.uOrigine.value.set(ux, uy - 0.1, -D / 2 + 0.25); Up.uPiece.value.set(W, H, D);
      // Unité extérieure : dehors, à droite du mur du fond, à une distance liée à la liaison
      var dx = W / 2 + 0.6 + Math.min(4, (cur.dist - 1) * 0.32), hy = { sol: 0, facade_basse: 0.55, facade_haute: H * 0.72, balcon: H, toiture: H + 0.2 }[emplacement] || 0;
      cur.ueY += (hy - cur.ueY) * 0.12;
      ue.position.set(dx, cur.ueY, -D / 2 + 0.16);
      // La façade extérieure prolonge le mur du fond : l'unité s'y adosse ; en toiture, elle pose sur une dalle
      var fl2 = dx + 0.75 - W / 2; facade.scale.set(fl2, H, 0.12); facade.position.set(W / 2 + fl2 / 2 + 0.06, H / 2, -D / 2 - 0.06);
      coupe.scale.set(0.12, 0.28, D); coupe.position.set(W / 2 + 0.06, 0.14, 0);
      var toit = emplacement === 'toiture' || emplacement === 'balcon'; dalle.visible = toit;
      dalle.scale.set(fl2, 0.1, 0.9); dalle.position.set(W / 2 + fl2 / 2, (emplacement === 'balcon' ? H : H + 0.2) - 0.05, -D / 2 + 0.2);
      // Liaison (cuivre) : de l'unité intérieure, à travers le mur, jusqu'à l'unité extérieure
      if (tube) { scene.remove(tube); tube.geometry.dispose(); }
      var pts = [new THREE.Vector3(ux + 0.46, uy, -D / 2 + 0.06), new THREE.Vector3(W / 2 - 0.05, uy, -D / 2 + 0.05), new THREE.Vector3(W / 2 + 0.2, uy, -D / 2 + 0.05),
        new THREE.Vector3(dx - 0.42, cur.ueY + 0.75, -D / 2 + 0.05), new THREE.Vector3(dx - 0.42, cur.ueY + 0.4, -D / 2 + 0.12)];
      tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 40, 0.022, 8, false), matTube); tube.castShadow = true; scene.add(tube);
      // Caméra : vue de trois quarts ; en vue « installation », recul et décalage vers l'extérieur
      var m = Math.max(W, D, H * 1.3), dist = m * 2.35 + 2.4 + cur.vue * 1.6;
      var ang = 0.72 + cur.vue * 0.22 + (reduit ? 0 : Math.sin(tempsCam * 0.25) * 0.035);
      camera.position.set(Math.sin(ang) * dist + cur.vue * 1.2, dist * 0.62, Math.cos(ang) * dist);
      camera.lookAt(cur.vue * 1.4, H * 0.36, -D * 0.08);
      voyant.material.color.set(cur.froid > 0.5 ? '#8ec5ff' : '#ffb985');
    }

    var enAttente = false, detruit = false, visible = true, tempsCam = 0, t0 = performance.now();
    function lerp(k, f) { var d = cib[k] - cur[k]; cur[k] += d * f; return Math.abs(d) > 0.002; }
    function image(t) {
      enAttente = false; if (detruit) return;
      var s = (t - t0) / 1000; tempsCam = s;
      // Les deux : le souffle alterne froid et chaud toutes les quatre secondes
      cib.froid = besoin === 'froid' ? 1 : besoin === 'chaud' ? 0 : (Math.sin(s * 0.8) > 0 ? 1 : 0);
      var f = reduit ? 1 : 0.09, bouge = false;
      ['W', 'D', 'H', 'baies', 'soleil', 'angle', 'force', 'actif', 'dist', 'vue'].forEach(function (k) { if (lerp(k, f)) bouge = true; });
      lerp('froid', reduit ? 1 : 0.05);
      Up.uTemps.value = s; Up.uForce.value = cur.force; Up.uFroid.value = cur.froid; Up.uActif.value = cur.actif;
      helice.rotation.z = s * 6;
      poser();
      rendu.render(scene, camera);
      if (visible && (!reduit || bouge) && !window.__fige) demander();
    }
    function demander() { if (!enAttente && !detruit) { enAttente = true; requestAnimationFrame(image); } }
    var io = new IntersectionObserver(function (es) { visible = es[0].isIntersecting; if (visible) demander(); }); io.observe(hote);
    var ro = new ResizeObserver(taille); ro.observe(hote);
    canvas.addEventListener('webglcontextlost', function (e) { e.preventDefault(); });
    canvas.addEventListener('webglcontextrestored', demander);
    taille(); hote.classList.add('piece--vivante');

    return {
      regler: regler, vue: vue,
      detruire: function () { detruit = true; io.disconnect(); ro.disconnect(); scene.traverse(function (o) { if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } }); rendu.dispose(); canvas.remove(); }
    };
  }
  window.QualiclimPiece = { monter: monter };
})();
