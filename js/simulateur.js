/*!
 * Qualiclim Sud — l'interface du simulateur : questions, pièce en 3D (piece3d.js), cadran de puissance,
 * transitions entre étapes. Le calcul vient de moteur.js (moteur d'estimation adapté, sans coûts ni marges).
 */
(() => {
  'use strict';
  const M = window.MoteurQualiclim, f = document.getElementById('simu');
  if (!M || !f) return;
  const $ = id => document.getElementById(id);
  const G = window.gsap;
  const reduit = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nb = (n, d = 1) => Number(n).toLocaleString('fr-FR', { maximumFractionDigits: d });
  const eur = n => Number(n).toLocaleString('fr-FR') + ' €';
  const chiffre = (txt, unite) => esc(txt).replace(/[,   ]/g, c => (c === ',' ? '<span class="v">,</span>' : '<span class="v v--e">&nbsp;</span>')) + (unite ? `<span class="u">${unite}</span>` : '');
  const NOMS = ['Séjour', 'Chambre', 'Chambre 2', 'Chambre 3', 'Bureau', 'Cuisine', 'Autre pièce'];
  const HAUTEURS = [[2.5, '2,5 m'], [2.7, '2,7 m'], [3, '3 m'], [3.5, 'Plus de 3 m']];
  const EXPOS = [['nord', 'Nord'], ['est', 'Est'], ['sud', 'Sud'], ['ouest', 'Ouest']];
  const PIECES_MAX = 6;
  const STATUTS = { estimable: 'Estimable en ligne', visite_requise: 'Visite technique nécessaire', en_attente: 'En attente de l\'accord du propriétaire', incomplet: 'Il manque une réponse' };
  const MANQUE = { 'logement.type': 'le type de logement', 'logement.codePostal': 'votre code postal (5 chiffres)', pieces: 'au moins une pièce', 'installation.distanceUnitesM': 'la distance entre les unités', 'installation.emplacementUe': 'l\'emplacement de l\'unité extérieure' };
  const CONFIG = { monosplit: 'Monosplit : une unité intérieure, une unité extérieure', multisplit: n => `Multisplit : ${n} unités intérieures, une seule unité extérieure`, etude_specifique: 'Plus de quatre pièces : étude sur place', indeterminee: 'Ajoutez une pièce' };
  const BESOIN = { froid: 'Rafraîchir', chaud: 'Chauffer', les_deux: 'Froid et chaud' };

  let etape = 0, active = 0;
  const grille = false; // site livrable : aucune grille fictive ; les prix réels viendront du client (mentions orange)
  let pieces = [{ nom: 'Séjour', surfaceM2: 25, exposition: 'sud', grandesBaiesVitrees: false, hauteurSousPlafondM: 2.5 }];

  // ---------------------------------------------------------------- 3D
  let piece = null;
  const hote = $('simu-scene');
  const monter3d = () => {
    if (piece || !window.QualiclimPiece) return;
    piece = window.QualiclimPiece.monter(hote);
    if (!piece) { const r = document.createElement('p'); r.className = 'repli'; r.textContent = 'La pièce en 3D demande un navigateur récent. Le calcul, lui, fonctionne.'; hote.appendChild(r); }
    else maj();
  };
  if ('IntersectionObserver' in window) { const io = new IntersectionObserver(es => { if (es[0].isIntersecting) { monter3d(); io.disconnect(); } }, { rootMargin: '60% 0px' }); io.observe(hote); } else monter3d();

  // ---------------------------------------------------------------- réponses
  const val = n => f.querySelector(`[name="${n}"]:checked`)?.value;
  const coche = n => f.querySelector(`[name="${n}"]`)?.checked === true;
  function reponses() {
    const age = val('age'), ligne = val('ligne');
    return {
      logement: { type: val('type'), statut: val('statut'), accordProprietaire: coche('accordProprietaire'), autorisationCopropriete: coche('autorisationCopropriete'),
        copropriete: val('type') === 'appartement', ancienneteAns: age === 'vieux' ? 10 : age === 'neuf' ? 1 : null,
        isolation: val('isolation'), dernierEtage: val('dernierEtage') === 'oui', codePostal: $('s-cp').value },
      pieces: pieces.map(p => ({ ...p })),
      installation: { emplacementUe: val('emplacementUe'), distanceUnitesM: Number($('s-dist').value), accesExterieur: val('accesExterieur'),
        ligneElectriqueDedieeExistante: ligne === 'oui' ? true : ligne === 'non' ? false : null,
        evacuationCondensats: val('condensats'), typeMur: val('typeMur'), deposeAncienMateriel: val('depose') === 'oui' },
      besoin: val('besoin')
    };
  }

  // ---------------------------------------------------------------- pièces
  const conteneur = $('simu-pieces');
  function rendrePieces() {
    conteneur.innerHTML = pieces.map((p, i) => `
      <div class="piece${i === active ? ' est-active' : ''}" data-i="${i}">
        <div class="piece__haut">
          <select data-champ="nom" aria-label="Pièce ${i + 1}">${NOMS.map(n => `<option${n === p.nom ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select>
          <span class="piece__kw" data-kw>—</span>
        </div>
        <div class="q"><p class="q__t"><label for="surf-${i}">Surface</label></p>
          <div class="curseur"><input id="surf-${i}" data-champ="surfaceM2" type="range" min="5" max="80" step="1" value="${p.surfaceM2}"><output class="chiffre" for="surf-${i}">${p.surfaceM2}<span class="u">m²</span></output></div></div>
        <div class="q"><p class="q__t" id="expo-${i}">Les fenêtres principales donnent au</p>
          <div class="choix" role="radiogroup" aria-labelledby="expo-${i}">${EXPOS.map(([v, l]) => `<label><input type="radio" name="expo-${i}" data-champ="exposition" value="${v}"${v === p.exposition ? ' checked' : ''}><span>${l}</span></label>`).join('')}</div></div>
        <div class="q"><p class="q__t" id="haut-${i}">Hauteur sous plafond</p>
          <div class="choix" role="radiogroup" aria-labelledby="haut-${i}">${HAUTEURS.map(([v, l]) => `<label><input type="radio" name="haut-${i}" data-champ="hauteurSousPlafondM" value="${v}"${v === p.hauteurSousPlafondM ? ' checked' : ''}><span>${l}</span></label>`).join('')}</div></div>
        <div class="piece__ligne">
          <label class="coche"><input type="checkbox" data-champ="grandesBaiesVitrees"${p.grandesBaiesVitrees ? ' checked' : ''}><span>Grandes baies vitrées</span></label>
          ${pieces.length > 1 ? `<button type="button" class="lien" data-retirer>Retirer cette pièce</button>` : ''}
        </div>
      </div>`).join('');
    $('ajout-piece').hidden = pieces.length >= PIECES_MAX;
    rendreOnglets();
  }
  function choisir(i) {
    active = Math.max(0, Math.min(pieces.length - 1, i));
    [...conteneur.querySelectorAll('.piece')].forEach((el, k) => el.classList.toggle('est-active', k === active));
    rendreOnglets(); maj();
  }
  conteneur.addEventListener('input', e => {
    const el = e.target, champ = el.dataset.champ, bloc = el.closest('.piece'); if (!champ || !bloc) return;
    const i = Number(bloc.dataset.i), p = pieces[i];
    if (champ === 'surfaceM2') { p.surfaceM2 = Number(el.value); el.nextElementSibling.innerHTML = `${el.value}<span class="u">m²</span>`; }
    else if (champ === 'grandesBaiesVitrees') p.grandesBaiesVitrees = el.checked;
    else if (champ === 'hauteurSousPlafondM') p.hauteurSousPlafondM = Number(el.value);
    else p[champ] = el.value;
    if (i !== active) choisir(i); else maj();
  });
  conteneur.addEventListener('focusin', e => { const b = e.target.closest('.piece'); if (b && Number(b.dataset.i) !== active) choisir(Number(b.dataset.i)); });
  conteneur.addEventListener('click', e => {
    const b = e.target.closest('[data-retirer]'); if (!b) return;
    pieces.splice(Number(b.closest('.piece').dataset.i), 1); active = Math.min(active, pieces.length - 1); rendrePieces(); maj();
    $('ajout-piece').focus();
  });
  $('ajout-piece').addEventListener('click', () => {
    if (pieces.length >= PIECES_MAX) return;
    const libre = NOMS.find(n => !pieces.some(p => p.nom === n)) || 'Autre pièce';
    pieces.push({ nom: libre, surfaceM2: 12, exposition: 'est', grandesBaiesVitrees: false, hauteurSousPlafondM: 2.5 });
    active = pieces.length - 1; rendrePieces(); maj();
    const nouvelle = conteneur.lastElementChild;
    if (G && !reduit) G.from(nouvelle, { height: 0, opacity: 0, y: 20, duration: .6, ease: 'power3.out', clearProps: 'height' });
    nouvelle?.querySelector('select')?.focus();
  });

  // Onglets des pièces sur la scène 3D
  const onglets = $('simu-onglets');
  let dernierCalcul = null;
  function rendreOnglets() {
    const dim = dernierCalcul ? dernierCalcul.dimensionnement : null;
    onglets.innerHTML = pieces.length > 1 ? pieces.map((p, i) => `<button type="button" aria-pressed="${i === active}" data-onglet="${i}">${esc(p.nom)}${dim && dim.pieces[i] ? `<b>${nb(dim.pieces[i].puissanceCalculeeKw)} kW</b>` : ''}</button>`).join('') : '';
  }
  onglets.addEventListener('click', e => { const b = e.target.closest('[data-onglet]'); if (b) choisir(Number(b.dataset.onglet)); });

  // ---------------------------------------------------------------- champs conditionnels et distance
  function conditions() {
    f.querySelectorAll('[data-si]').forEach(el => { const [n, v] = el.dataset.si.split('='); el.hidden = val(n) !== v; });
    const d = Number($('s-dist').value), std = M.REGLES.installationStandard;
    $('s-dist-v').innerHTML = `${d}<span class="u">m</span>`;
    $('s-dist-aide').textContent = d <= std.distanceUnitesMaxM ? `Jusqu'à ${std.distanceUnitesMaxM} m : pose standard, dos à dos.`
      : d <= 5 ? 'De 3 à 5 m : liaison plus longue, en supplément.' : d <= 8 ? 'De 5 à 8 m : liaison longue, en supplément.' : 'Au-delà de 8 m : chiffrage après visite.';
  }

  // ---------------------------------------------------------------- cadran
  const arc = $('jauge-arc'), LONG = 433.5; // 3/4 de la circonférence (r = 92)
  const jauge = { v: 0 };
  function cadran(kw, froid) {
    const cible = Math.max(0, Math.min(1, kw / 9));
    const peindre = () => { arc.setAttribute('stroke-dasharray', `${(jauge.v * LONG).toFixed(1)} 578`); };
    arc.style.stroke = froid === 'froid' ? '#4f9be8' : froid === 'chaud' ? '#e08a3c' : '#f4f2ee';
    if (G && !reduit) G.to(jauge, { v: cible, duration: .9, ease: 'power3.out', onUpdate: peindre, overwrite: true }); else { jauge.v = cible; peindre(); }
  }
  const kwAff = { v: 0 };
  function compteur(kw) {
    const ecrire = () => { const t = kwAff.v > 0 ? chiffre(nb(kwAff.v)) : '—'; $('l-kw').innerHTML = t; $('l-kw2').innerHTML = t; };
    if (G && !reduit) G.to(kwAff, { v: kw, duration: .8, ease: 'power3.out', onUpdate: ecrire, overwrite: true }); else { kwAff.v = kw; ecrire(); }
  }

  // ---------------------------------------------------------------- calcul et affichage
  function maj() {
    conditions();
    const r = M.estimer(reponses(), { grilleFictive: grille });
    dernierCalcul = r;
    const dim = r.dimensionnement;
    conteneur.querySelectorAll('.piece').forEach((el, i) => { const p = dim.pieces[i]; el.querySelector('[data-kw]').innerHTML = p ? chiffre(nb(p.puissanceCalculeeKw), 'kW') : '—'; });
    const total = dim.pieces.length ? dim.puissanceTotaleKw : 0;
    compteur(total); cadran(total, val('besoin'));
    const conf = dim.configuration === 'multisplit' ? CONFIG.multisplit(dim.pieces.length) : CONFIG[dim.configuration];
    $('l-conf').textContent = `${conf} · ${nb(dim.surfaceTotaleM2, 0)} m²`;
    $('l-statut').innerHTML = `<span class="etat">${STATUTS[r.statut]}</span>`;
    const surDevis = r.supplements.filter(s => s.surDevis).length;
    $('l-sup').textContent = r.supplements.length ? `${r.supplements.length} détecté${r.supplements.length > 1 ? 's' : ''}${surDevis ? `, dont ${surDevis} après visite` : ''}` : 'Aucun : pose standard';
    $('l-prix').innerHTML = '<span class="a-confirmer">[À CONFIRMER — CLIENT : grille tarifaire]</span>';
    // Étiquettes de la scène
    const pa = pieces[active], da = dim.pieces[active];
    $('e-piece').textContent = pa ? `${pa.nom} · ${pa.surfaceM2} m²${da ? ' · ' + nb(da.puissanceCalculeeKw) + ' kW' : ''}` : '';
    $('e-souffle').innerHTML = `<i></i>${BESOIN[val('besoin')] || ''}`;
    rendreOnglets();
    // Pièce 3D
    if (piece && pa) piece.regler({ surface: pa.surfaceM2, hauteur: pa.hauteurSousPlafondM, exposition: pa.exposition, baies: pa.grandesBaiesVitrees, besoin: val('besoin'), kw: da ? da.puissanceCalculeeKw : 2, emplacement: val('emplacementUe'), distance: Number($('s-dist').value) });
    if (etape === 3) rendreResultat(r);
    return r;
  }

  function rendreResultat(r) {
    const dim = r.dimensionnement, maxKw = Math.max(1, ...dim.pieces.map(p => p.puissanceCalculeeKw));
    const piecesHtml = dim.pieces.map(p => `
      <div class="res__ligne"><span><strong>${esc(p.nom)}</strong> · ${nb(p.surfaceM2, 0)} m²</span><span class="val">${chiffre(nb(p.puissanceCalculeeKw), 'kW')}</span>
        <span class="res__barre"><i style="--l:${(p.puissanceCalculeeKw / maxKw * 100).toFixed(0)}%"></i></span>
        <span class="facteurs">${p.facteurs.length ? p.facteurs.map(x => `${x.effet > 0 ? '+' : '−'}${nb(Math.abs(x.effet) * 100, 0)} % ${esc(x.libelle.toLowerCase())}`).join(' · ') : 'Aucune majoration'}${p.tailleConseilleeKw ? ` · appareil courant : ${nb(p.tailleConseilleeKw)} kW` : ''}</span></div>`).join('');
    const supHtml = r.supplements.length ? r.supplements.map(s => {
      const p = grille ? M.GRILLE_FICTIVE.supplements[s.code] : undefined;
      return `<div class="res__ligne"><span><strong>${esc(s.libelle)}</strong></span><span class="val">${s.surDevis ? 'après visite' : p !== undefined ? chiffre(Number(p).toLocaleString('fr-FR'), '€') : '<span class="a-confirmer">[À CONFIRMER — CLIENT : prix]</span>'}</span><span class="facteurs">${esc(s.motif)}</span></div>`;
    }).join('') : '<p class="res__note">Aucun : votre projet correspond à une pose standard.</p>';
    const alertes = [...r.blocages, ...r.alertes].map(a => `<li>${esc(a.message)}</li>`).join('');
    const visite = r.motifsVisite.map(m => `<li>${esc(m)}</li>`).join('');
    const manque = r.champsManquants.map(c => MANQUE[c] || 'la surface d\'une pièce');
    const zone = r.zone.dansSecteur === true ? `${esc(r.zone.commune)} : dans notre secteur, de Fréjus à Cannes.`
      : r.zone.dansSecteur === false ? 'Hors de notre secteur habituel, de Fréjus à Cannes : appelez-nous au 06 34 49 32 49, nous vous dirons si nous pouvons venir.' : '';
    const prix = '<p class="res__note"><span class="a-confirmer">[À CONFIRMER — CLIENT : prix par gamme, suppléments et offres à afficher dans le simulateur]</span></p><p class="res__note">En attendant, le prix se donne sur devis, après vérification chez vous.</p>';
    $('simu-resultat').innerHTML = `
      <div class="bascule"><h3>Votre estimation</h3><span class="etat">${STATUTS[r.statut]}</span></div>
      ${manque.length ? `<p class="res__note">Il manque : ${esc(manque.join(', '))}. <button type="button" class="lien" data-aller-a="${r.champsManquants[0]?.startsWith('installation') ? 2 : r.champsManquants[0]?.startsWith('pieces') ? 1 : 0}">Compléter</button></p>` : ''}
      <div class="res__bloc"><h4>Puissance conseillée : ${nb(dim.puissanceTotaleKw)} kW</h4><p class="res__note">${dim.configuration === 'multisplit' ? CONFIG.multisplit(dim.pieces.length) : CONFIG[dim.configuration]}.</p>${piecesHtml}</div>
      ${visite ? `<div class="res__bloc"><h4>Ce qu'un technicien doit voir sur place</h4><ul class="res__liste">${visite}</ul></div>` : ''}
      <div class="res__bloc"><h4>Ce que la pose demande en plus</h4>${supHtml}</div>
      ${alertes ? `<div class="res__bloc"><h4>À vérifier</h4><ul class="res__liste">${alertes}</ul></div>` : ''}
      <div class="res__bloc"><h4>Prix</h4><p class="res__note">Marques posées : principalement Mitsubishi Electric et Mundoclima.</p>${prix}</div>
      <div class="res__bloc"><h4>TVA, aides et secteur</h4><p class="res__note">${esc(r.tva.texte)}</p>
        <p class="res__note">Prime CEE : <span class="a-confirmer">[À CONFIRMER — CLIENT : accompagnement aux primes]</span></p>${zone ? `<p class="res__note">${zone}</p>` : ''}</div>
      <div class="res__mentions">${r.mentionsEstimation.map(m => `<p>${esc(m)}</p>`).join('')}</div>`;
    if (G && !reduit) {
      G.from('#simu-resultat .res__bloc, #simu-resultat > .bascule', { y: 24, opacity: 0, duration: .7, ease: 'power3.out', stagger: .07 });
      G.from('#simu-resultat .res__barre i', { scaleX: 0, duration: 1, ease: 'power3.out', stagger: .08, delay: .2 });
    }
  }
  $('simu-resultat').addEventListener('click', e => {
    const a = e.target.closest('[data-aller-a]'); if (a) aller(Number(a.dataset.allerA));
  });

  // ---------------------------------------------------------------- étapes
  const etapes = [...f.querySelectorAll('[data-etape]')], ongletsEtapes = [...f.querySelectorAll('[data-aller]')];
  function aller(n, defiler = true) {
    const avant = etape;
    etape = Math.max(0, Math.min(3, n));
    const sortante = etapes[avant], entrante = etapes[etape];
    const montrer = () => {
      etapes.forEach(el => { el.hidden = Number(el.dataset.etape) !== etape; });
      ongletsEtapes.forEach(b => { if (Number(b.dataset.aller) === etape) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current'); });
      $('simu-barre').style.width = `${(etape + 1) * 25}%`;
      $('s-prec').disabled = etape === 0;
      $('s-suiv').hidden = etape === 3;
      $('s-suiv').textContent = etape === 2 ? 'Voir mon estimation' : 'Suivant';
      if (piece) piece.vue(etape === 2 ? 'installation' : 'piece');
      maj();
      if (G && !reduit && defiler) G.fromTo(entrante, { x: etape > avant ? 40 : -40, opacity: 0 }, { x: 0, opacity: 1, duration: .55, ease: 'power3.out', clearProps: 'transform,opacity' });
      if (defiler) {
        const haut = f.getBoundingClientRect().top;
        if (haut < 0 || haut > innerHeight * .6) f.scrollIntoView({ behavior: reduit ? 'auto' : 'smooth', block: 'start' });
        const cible = entrante.querySelector('legend, h3');
        if (cible) { cible.setAttribute('tabindex', '-1'); cible.focus({ preventScroll: true }); }
      }
    };
    if (G && !reduit && defiler && sortante && sortante !== entrante) G.to(sortante, { x: etape > avant ? -40 : 40, opacity: 0, duration: .25, ease: 'power2.in', onComplete: () => { G.set(sortante, { clearProps: 'transform,opacity' }); montrer(); } });
    else montrer();
  }
  ongletsEtapes.forEach(b => b.addEventListener('click', () => aller(Number(b.dataset.aller))));
  $('s-prec').addEventListener('click', () => aller(etape - 1));
  $('s-suiv').addEventListener('click', () => aller(etape + 1));
  f.addEventListener('input', e => { if (!e.target.closest('#simu-pieces')) maj(); });
  f.addEventListener('submit', e => e.preventDefault());
  $('s-cp').addEventListener('input', e => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 5); });
  let envoiEnCours = false;
  $('s-envoyer').addEventListener('click', async () => {
    if (envoiEnCours) return;
    const nom = $('s-nom').value.trim(), mail = $('s-mail').value.trim(), tel = $('s-tel').value.trim(), out = $('s-retour');
    if (nom.length < 2) { out.textContent = 'Indiquez votre nom.'; $('s-nom').focus(); return; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) { out.textContent = 'Indiquez une adresse e-mail valide pour que nous puissions vous répondre.'; $('s-mail').focus(); return; }
    if (tel && !/^[+0-9 ().-]{9,}$/.test(tel)) { out.textContent = 'Ce numéro de téléphone semble incomplet.'; $('s-tel').focus(); return; }
    const r = dernierCalcul || maj(), dim = r.dimensionnement;
    const lignes = ['Estimation envoyée depuis le simulateur du site.', `Logement : ${val('type') === 'appartement' ? 'appartement' : 'maison'} · code postal ${$('s-cp').value || 'non indiqué'}`,
      `Puissance conseillée : ${nb(dim.puissanceTotaleKw)} kW · ${dim.configuration === 'multisplit' ? CONFIG.multisplit(dim.pieces.length) : CONFIG[dim.configuration]}`,
      ...dim.pieces.map(p => `- ${p.nom} : ${nb(p.surfaceM2, 0)} m², ${nb(p.puissanceCalculeeKw)} kW`),
      `Unité extérieure : ${val('emplacementUe') || 'non précisé'} · distance ${$('s-dist').value} m`,
      r.supplements.length ? `Suppléments détectés : ${r.supplements.map(x => x.libelle).join(', ')}` : 'Pose standard.',
      coche('rappel') ? 'Souhaite être rappelé·e.' : 'Ne demande pas de rappel.'];
    envoiEnCours = true; out.textContent = 'Envoi…';
    const res = window.QualiclimEnvoi ? await window.QualiclimEnvoi.envoyer({ nom, email: mail, telephone: tel, message: lignes.join('\n'), rappel: coche('rappel'), details: [
      ['Logement', `${val('type') === 'appartement' ? 'Appartement' : 'Maison'} · code postal ${$('s-cp').value || 'non indiqué'}`],
      ['Puissance conseillée', `${nb(dim.puissanceTotaleKw)} kW · ${dim.configuration === 'multisplit' ? CONFIG.multisplit(dim.pieces.length) : CONFIG[dim.configuration]}`],
      ['Pièces', dim.pieces.map(p => `${p.nom} ${nb(p.surfaceM2, 0)} m² (${nb(p.puissanceCalculeeKw)} kW)`).join(' · ')],
      ['Unité extérieure', `${val('emplacementUe') || 'non précisé'} · distance ${$('s-dist').value} m`],
      ['Suppléments', r.supplements.length ? r.supplements.map(x => x.libelle).join(', ') : 'pose standard']] }, 'simulateur') : { ok: false, nonRelie: true };
    envoiEnCours = false;
    out.textContent = res.ok ? 'Merci, votre estimation nous est parvenue. Nous vous répondons par e-mail' + (coche('rappel') ? ', et nous vous rappelons comme vous l\'avez demandé.' : '.')
      : res.nonRelie ? "Aperçu du site : l'envoi sera relié à la mise en ligne, rien n'a été envoyé. En attendant, appelez-nous au 06 34 49 32 49."
      : (res.erreurs && res.erreurs.length ? res.erreurs.join(' ') + ' ' : "L'envoi n'a pas abouti. ") + 'Vous pouvez aussi nous appeler au 06 34 49 32 49.';
  });

  rendrePieces();
  aller(0, false);
})();
