/*
 * Moteur du simulateur Qualiclim Sud — adaptation du moteur d'estimation PAC air-air
 * (AERALTO, module `moteur/`, règles du 18/08/2026) fourni par David.
 *
 * Ce qui est REPRIS tel quel : la méthode de dimensionnement pièce par pièce (base en W/m²
 * et majorations), la définition de l'installation standard, la détection des suppléments,
 * les motifs de visite, les règles de TVA et les deux phrases du mode estimatif.
 *
 * Ce qui est RETIRÉ, et pourquoi :
 *  - coûts d'achat, coûts de pose, marges, scoring : rien de tout cela n'a sa place dans
 *    un navigateur. Le moteur d'origine les filtrait par versionClient() ; ici ils
 *    n'existent pas, il n'y a donc rien qui puisse fuir ;
 *  - catalogue, grille de prix, offre à 999 €, zones de l'Isère, prime CEE de la zone H1 :
 *    ce sont les données d'une AUTRE entreprise. Pour Qualiclim Sud, elles viennent du
 *    client ou restent « À CONFIRMER ». Une grille FICTIVE, signalée comme telle à chaque
 *    prix, peut être affichée pour la démonstration de la maquette.
 *
 * Fonction pure : mêmes réponses, même résultat. Aucune horloge, aucun réseau.
 */
(function (racine) {
  'use strict';

  const REGLES = {
    version: 'qualiclim-maquette-1 (règles AERALTO v1.0.0 du 18/08/2026)',
    dimensionnement: {
      basePuissanceWparM2: 90,
      hauteurReferenceM: 2.5,
      majorations: {
        isolationAncienne: 0.2, isolationMoyenne: 0, isolationRecente: -0.15,
        expositionSud: 0.1, expositionOuest: 0.05, grandesBaiesVitrees: 0.15,
        dernierEtageOuCombles: 0.15, hauteurSousPlafondParMetreSup: 0.12
      },
      bandes: [
        { surfaceMax: 20, kwMin: 2.0, kwMax: 2.5 },
        { surfaceMax: 30, kwMin: 2.5, kwMax: 3.5 },
        { surfaceMax: 45, kwMin: 3.5, kwMax: 5.0 },
        { surfaceMax: 60, kwMin: 5.0, kwMax: 6.5 }
      ],
      surfaceVisiteObligatoire: 60,
      puissanceMaxMonospliteKw: 7.0,
      piecesMaxSansVisite: 4
    },
    installationStandard: {
      distanceUnitesMaxM: 3,
      paliersLiaisonM: [{ maxM: 5, code: 'LIAISON_5M' }, { maxM: 8, code: 'LIAISON_8M' }],
      hauteurUeMaxM: 1.8,
      typesMurInclus: ['parpaing', 'brique', 'beton_banche', 'ossature_bois']
    },
    // Tailles d'appareils couramment proposées sur le marché, pour traduire une puissance
    // calculée en un ordre de grandeur lisible. Ce n'est pas le catalogue du client.
    tailles: [2.0, 2.5, 3.5, 4.2, 5.0, 6.0, 7.1],
    tva: {
      ancienneteMinAns: 2,
      reduit: 0.055, normal: 0.2,
      // Art. 278-0 bis A CGI + arrêté du 13/07/2026, vérifiés le 18/08/2026 dans le moteur d'origine.
      criteres: 'appareil réversible et connecté, classe A++ en chauffage et en refroidissement pour un monosplit (A+ pour un multisplit), puissance de 12 kW au plus'
    },
    supplements: [
      { code: 'LIAISON_5M', libelle: 'Liaison frigorifique de 3 à 5 m' },
      { code: 'LIAISON_8M', libelle: 'Liaison frigorifique de 5 à 8 m' },
      { code: 'LIAISON_LONGUE', libelle: 'Liaison de plus de 8 m', surDevis: true },
      { code: 'UE_HAUTEUR', libelle: 'Unité extérieure sur console en hauteur' },
      { code: 'UE_TOITURE', libelle: 'Pose en toiture ou toit-terrasse', surDevis: true, visiteRequise: true },
      { code: 'ACCES_NACELLE', libelle: 'Accès par nacelle ou échafaudage', surDevis: true, visiteRequise: true },
      { code: 'MUR_DIFFICILE', libelle: 'Percement en pierre ou béton armé' },
      { code: 'POMPE_RELEVAGE', libelle: 'Pompe de relevage des condensats' },
      { code: 'LIGNE_ELEC', libelle: 'Création d\'une ligne électrique dédiée' },
      { code: 'DEPOSE_ANCIEN', libelle: 'Dépose de l\'ancien appareil (fluide récupéré, filière DEEE)' }
    ],
    // Secteur donné par le client : toute la côte, de Fréjus à Cannes. Dépôt : Fréjus.
    communes: { '83600': 'Fréjus', '83700': 'Saint-Raphaël', '83530': 'Agay (Saint-Raphaël)', '06590': 'Théoule-sur-Mer', '06210': 'Mandelieu-la-Napoule', '06400': 'Cannes', '06150': 'Cannes' }
  };

  // GRILLE FICTIVE — démonstration de la maquette uniquement. Reprise de la grille d'exemple
  // du moteur d'origine ; elle n'engage pas Qualiclim Sud et chaque prix affiché le dit.
  const GRILLE_FICTIVE = {
    gammes: [
      { id: 'essentiel', libelle: 'Essentiel', mono: { 2.5: 1290, 3.5: 1490 } },
      { id: 'confort', libelle: 'Confort', mono: { 2.5: 1690, 3.5: 1890, 5.0: 2290 }, multi: { 2: 3390, 3: 4690, 4: 5990 } },
      { id: 'premium', libelle: 'Premium', mono: { 2.5: 2190, 3.5: 2490 } }
    ],
    multiKw: { 2: 5.0, 3: 6.8, 4: 8.0 },
    supplements: { LIAISON_5M: 120, LIAISON_8M: 250, UE_HAUTEUR: 150, MUR_DIFFICILE: 130, POMPE_RELEVAGE: 220, LIGNE_ELEC: 350, DEPOSE_ANCIEN: 200 }
  };

  const arrondi = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
  const nombre = (v, defaut = null) => { const n = typeof v === 'string' ? Number(v.replace(',', '.')) : v; return Number.isFinite(n) ? n : defaut; };
  const parmi = (v, liste, defaut = null) => (typeof v === 'string' && liste.includes(v) ? v : defaut);
  const booleen = (v, defaut = null) => (typeof v === 'boolean' ? v : defaut);

  /** Ne jette jamais : un champ mal rempli remonte en `champsManquants`. */
  function normaliser(brut = {}) {
    const manquants = [];
    const l = brut.logement || {};
    const logement = {
      type: parmi(l.type, ['maison', 'appartement']),
      statut: parmi(l.statut, ['proprietaire', 'locataire'], 'proprietaire'),
      copropriete: booleen(l.copropriete, l.type === 'appartement'),
      autorisationCopropriete: booleen(l.autorisationCopropriete, false),
      accordProprietaire: booleen(l.accordProprietaire, false),
      ancienneteAns: nombre(l.ancienneteAns, null),
      isolation: parmi(l.isolation, ['recente', 'moyenne', 'ancienne'], 'moyenne'),
      codePostal: typeof l.codePostal === 'string' && /^\d{5}$/.test(l.codePostal.trim()) ? l.codePostal.trim() : null,
      dernierEtage: booleen(l.dernierEtage, false)
    };
    if (!logement.type) manquants.push('logement.type');
    if (!logement.codePostal) manquants.push('logement.codePostal');

    const pieces = (Array.isArray(brut.pieces) ? brut.pieces : []).map((p, i) => ({
      nom: typeof p?.nom === 'string' && p.nom.trim() ? p.nom.trim() : `Pièce ${i + 1}`,
      surfaceM2: nombre(p?.surfaceM2, null),
      hauteurSousPlafondM: nombre(p?.hauteurSousPlafondM, 2.5),
      exposition: parmi(p?.exposition, ['nord', 'sud', 'est', 'ouest'], 'est'),
      grandesBaiesVitrees: booleen(p?.grandesBaiesVitrees, false)
    }));
    if (!pieces.length) manquants.push('pieces');
    pieces.forEach((p, i) => { if (p.surfaceM2 === null || p.surfaceM2 <= 0) manquants.push(`pieces[${i}].surfaceM2`); });

    const i = brut.installation || {};
    const installation = {
      emplacementUe: parmi(i.emplacementUe, ['sol', 'facade_basse', 'facade_haute', 'balcon', 'toiture']),
      distanceUnitesM: nombre(i.distanceUnitesM, null),
      accesExterieur: parmi(i.accesExterieur, ['plain_pied', 'echelle', 'nacelle'], 'plain_pied'),
      ligneElectriqueDedieeExistante: booleen(i.ligneElectriqueDedieeExistante, null),
      evacuationCondensats: parmi(i.evacuationCondensats, ['gravitaire', 'pompe_requise', 'inconnu'], 'inconnu'),
      typeMur: parmi(i.typeMur, ['parpaing', 'brique', 'beton_banche', 'pierre', 'beton_arme', 'ossature_bois', 'inconnu'], 'inconnu'),
      deposeAncienMateriel: booleen(i.deposeAncienMateriel, false)
    };
    if (installation.distanceUnitesM === null) manquants.push('installation.distanceUnitesM');
    if (installation.emplacementUe === null) manquants.push('installation.emplacementUe');

    return { donnees: { logement, pieces, installation, besoin: parmi(brut.besoin, ['froid', 'chaud', 'les_deux'], 'les_deux') }, champsManquants: manquants };
  }

  function calculerPiece(piece, logement, R) {
    const dim = R.dimensionnement, m = dim.majorations, surface = piece.surfaceM2 || 0;
    const facteurs = []; let coef = 1;
    const parIsolation = { ancienne: m.isolationAncienne, moyenne: m.isolationMoyenne, recente: m.isolationRecente }[logement.isolation] || 0;
    if (parIsolation) { coef += parIsolation; facteurs.push({ libelle: `Isolation ${logement.isolation}`, effet: parIsolation }); }
    if (piece.exposition === 'sud') { coef += m.expositionSud; facteurs.push({ libelle: 'Exposition sud', effet: m.expositionSud }); }
    else if (piece.exposition === 'ouest') { coef += m.expositionOuest; facteurs.push({ libelle: 'Exposition ouest', effet: m.expositionOuest }); }
    if (piece.grandesBaiesVitrees) { coef += m.grandesBaiesVitrees; facteurs.push({ libelle: 'Grandes baies vitrées', effet: m.grandesBaiesVitrees }); }
    if (logement.dernierEtage) { coef += m.dernierEtageOuCombles; facteurs.push({ libelle: 'Dernier étage ou combles', effet: m.dernierEtageOuCombles }); }
    const h = piece.hauteurSousPlafondM ?? dim.hauteurReferenceM;
    if (h > dim.hauteurReferenceM) { const e = arrondi((h - dim.hauteurReferenceM) * m.hauteurSousPlafondParMetreSup, 3); coef += e; facteurs.push({ libelle: `Plafond à ${String(h).replace('.', ',')} m`, effet: e }); }
    const kw = arrondi(surface * dim.basePuissanceWparM2 * coef / 1000, 2);
    const bande = dim.bandes.find(b => surface <= b.surfaceMax) || null;
    return { nom: piece.nom, surfaceM2: surface, coefficient: arrondi(coef, 3), facteurs, puissanceCalculeeKw: kw,
      fourchetteKw: bande ? { min: bande.kwMin, max: bande.kwMax } : null, horsBande: !bande, depasseFourchette: bande ? kw > bande.kwMax : true,
      tailleConseilleeKw: R.tailles.find(t => t >= kw) ?? null };
  }

  function dimensionner(d, R) {
    const dim = R.dimensionnement;
    const pieces = d.pieces.map(p => calculerPiece(p, d.logement, R));
    const puissanceTotaleKw = arrondi(pieces.reduce((s, p) => s + p.puissanceCalculeeKw, 0), 2);
    const surfaceTotaleM2 = arrondi(pieces.reduce((s, p) => s + p.surfaceM2, 0), 1);
    const motifs = [];
    if (pieces.some(p => p.horsBande)) motifs.push(`Une pièce dépasse ${dim.surfaceVisiteObligatoire} m² : un bilan thermique est nécessaire.`);
    if (pieces.some(p => p.puissanceCalculeeKw > dim.puissanceMaxMonospliteKw)) motifs.push('La puissance demandée dépasse celle d\'un appareil mural courant.');
    if (d.pieces.length > dim.piecesMaxSansVisite) motifs.push('Plus de quatre pièces à équiper : une étude sur place est indispensable.');
    const atypiques = pieces.filter(p => p.depasseFourchette && !p.horsBande);
    if (atypiques.length) motifs.push(`Puissance au-dessus de l'usage pour ${atypiques.map(p => p.nom).join(', ')} : le technicien la validera.`);
    const configuration = !pieces.length ? 'indeterminee' : pieces.length === 1 ? 'monosplit' : pieces.length <= dim.piecesMaxSansVisite ? 'multisplit' : 'etude_specifique';
    return { pieces, puissanceTotaleKw, surfaceTotaleM2, configuration, visiteObligatoire: motifs.length > 0, motifsVisite: motifs };
  }

  function detecterSupplements(d, R) {
    const std = R.installationStandard, parCode = Object.fromEntries(R.supplements.map(s => [s.code, s]));
    const lignes = [], alertes = [];
    const ajouter = (code, motif) => { const s = parCode[code]; if (s) lignes.push({ code, libelle: s.libelle, surDevis: !!s.surDevis, visiteRequise: !!s.visiteRequise, motif }); };
    const i = d.installation, dist = i.distanceUnitesM;
    if (dist !== null && dist > std.distanceUnitesMaxM) {
      const palier = std.paliersLiaisonM.find(p => dist <= p.maxM);
      ajouter(palier ? palier.code : 'LIAISON_LONGUE', `${String(dist).replace('.', ',')} m entre les deux unités (inclus : ${std.distanceUnitesMaxM} m)`);
    }
    if (i.emplacementUe === 'toiture') ajouter('UE_TOITURE', 'Unité extérieure en toiture');
    else if (i.emplacementUe === 'facade_haute') ajouter('UE_HAUTEUR', `Unité extérieure à plus de ${String(std.hauteurUeMaxM).replace('.', ',')} m`);
    if (i.accesExterieur === 'nacelle') ajouter('ACCES_NACELLE', 'Accès difficile depuis l\'extérieur');
    if (i.typeMur === 'pierre' || i.typeMur === 'beton_arme') ajouter('MUR_DIFFICILE', i.typeMur === 'pierre' ? 'Mur en pierre' : 'Mur en béton armé');
    else if (i.typeMur === 'inconnu') alertes.push({ code: 'MUR_INCONNU', message: 'La nature du mur à percer sera vérifiée : un mur en pierre ou en béton armé demande un percement spécial.' });
    if (i.evacuationCondensats === 'pompe_requise') ajouter('POMPE_RELEVAGE', 'L\'eau ne peut pas s\'écouler naturellement');
    else if (i.evacuationCondensats === 'inconnu') alertes.push({ code: 'CONDENSATS_INCONNU', message: 'L\'écoulement de l\'eau de l\'appareil sera vérifié : une petite pompe peut s\'avérer nécessaire.' });
    if (i.ligneElectriqueDedieeExistante === false) ajouter('LIGNE_ELEC', 'Pas de ligne électrique dédiée');
    else if (i.ligneElectriqueDedieeExistante === null) alertes.push({ code: 'LIGNE_ELEC_INCONNUE', message: 'Une photo de votre tableau électrique nous dira si une ligne dédiée est à créer.' });
    if (i.deposeAncienMateriel) ajouter('DEPOSE_ANCIEN', 'Un ancien appareil est à retirer');
    return { lignes, alertes, visiteRequise: lignes.some(l => l.visiteRequise || l.surDevis) };
  }

  function controlerConformite(d, R) {
    const blocages = [], alertes = [];
    if (d.logement.statut === 'locataire' && !d.logement.accordProprietaire) {
      blocages.push({ code: 'LOCATAIRE_SANS_ACCORD', message: 'L\'accord écrit de votre propriétaire est nécessaire avant toute pose (percement, unité en façade).' });
    }
    if (d.logement.copropriete && !d.logement.autorisationCopropriete) {
      alertes.push({ code: 'COPRO_SANS_AUTORISATION', message: 'En copropriété, l\'unité extérieure demande l\'accord de l\'assemblée générale. Nous pouvons vous aider à préparer la demande.' });
    }
    const a = d.logement.ancienneteAns, min = R.tva.ancienneteMinAns;
    let tva;
    if (a === null) tva = { mode: 'indetermine', texte: 'Le taux de TVA sera fixé une fois l\'âge de votre logement vérifié.' };
    else if (a < min) tva = { mode: 'normal', taux: R.tva.normal, texte: 'Logement de moins de deux ans : TVA à 20 %.' };
    else tva = { mode: 'reduit_possible', taux: R.tva.reduit, texte: `Logement de plus de deux ans : TVA à 5,5 % si l'appareil est éligible (${R.tva.criteres}).` };
    return { blocages, alertes, tva };
  }

  function localiser(cp, R) {
    if (!cp) return { commune: null, dansSecteur: null };
    const commune = R.communes[cp] || null;
    return { commune, dansSecteur: !!commune };
  }

  function chiffrerFictif(dim, sup, G) {
    const extra = sup.lignes.filter(l => !l.surDevis).reduce((s, l) => s + (G.supplements[l.code] || 0), 0);
    const surDevis = sup.lignes.filter(l => l.surDevis).map(l => l.libelle);
    const props = [];
    if (dim.configuration === 'monosplit') {
      const kw = dim.pieces[0].puissanceCalculeeKw;
      for (const g of G.gammes) {
        const taille = Object.keys(g.mono).map(Number).sort((x, y) => x - y).find(t => t >= kw);
        if (taille) props.push({ gamme: g.libelle, appareil: `Monosplit ${String(taille).replace('.', ',')} kW`, prixBase: g.mono[taille], supplements: extra, total: g.mono[taille] + extra, surDevis });
      }
    } else if (dim.configuration === 'multisplit') {
      const n = dim.pieces.length;
      for (const g of G.gammes) if (g.multi && g.multi[n] && G.multiKw[n] >= dim.puissanceTotaleKw) props.push({ gamme: g.libelle, appareil: `Multisplit ${n} unités · ${String(G.multiKw[n]).replace('.', ',')} kW`, prixBase: g.multi[n], supplements: extra, total: g.multi[n] + extra, surDevis });
    }
    return props;
  }

  function estimer(reponses, options = {}) {
    const R = options.regles || REGLES;
    const { donnees, champsManquants } = normaliser(reponses);
    const conformite = controlerConformite(donnees, R);
    const dim = dimensionner(donnees, R);
    const sup = detecterSupplements(donnees, R);
    const zone = localiser(donnees.logement.codePostal, R);
    const statut = conformite.blocages.length ? 'en_attente'
      : (dim.visiteObligatoire || sup.visiteRequise) ? 'visite_requise'
      : champsManquants.length ? 'incomplet' : 'estimable';
    const motifsVisite = [...dim.motifsVisite, ...sup.lignes.filter(l => l.visiteRequise || l.surDevis).map(l => `${l.libelle} : à voir sur place.`)];
    return {
      meta: { versionRegles: R.version },
      statut, champsManquants, zone,
      dimensionnement: dim,
      supplements: sup.lignes,
      alertes: [...conformite.alertes, ...sup.alertes],
      blocages: conformite.blocages,
      motifsVisite,
      tva: conformite.tva,
      // Prix : la grille de Qualiclim Sud n'existe pas encore. Rien n'est inventé.
      prix: options.grilleFictive ? { fictif: true, propositions: chiffrerFictif(dim, sup, GRILLE_FICTIVE) } : null,
      mentionsEstimation: [
        'Estimation indicative établie à partir des informations que vous avez déclarées. Une validation technique est nécessaire avant tout engagement.',
        'Prix susceptibles d\'évoluer après visite technique ou en cas d\'informations complémentaires.'
      ]
    };
  }

  racine.MoteurQualiclim = { estimer, REGLES, GRILLE_FICTIVE };
})(typeof globalThis !== 'undefined' ? globalThis : window);
