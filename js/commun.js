/*!
 * Qualiclim Sud — ce qui sert à toutes les pages : l'année de la signature, le bandeau de consentement.
 *
 * Bandeau (standard Belle Devanture, contrôle PRIV-COOKIE-01) : présent seulement quand le site mesure son
 * audience (kit de mesure v2 posé par outils/fabriquer.mjs). Rien ne part vers Google avant l'accord : le kit
 * refuse tout par défaut ; on lui transmet l'accord par bdAnalyticsConsent(), le retrait par bdAnalyticsRevoke().
 * Règles CNIL tenues : « Refuser » au même niveau qu'« Accepter », choix gardé 6 mois puis redemandé,
 * modifiable à tout moment par « Gérer mes cookies » en pied de page. Sans JavaScript : ni bandeau, ni mesure.
 */
(() => {
  'use strict';
  document.querySelectorAll('[data-annee]').forEach(e => { e.textContent = new Date().getFullYear(); });

  const bandeau = document.querySelector('[data-bd-consentement]');
  if (!bandeau) return;
  const CLE = 'bd-consentement', DUREE_MS = 1000 * 60 * 60 * 24 * 182; // ≈ 6 mois (recommandation CNIL)
  const lire = () => {
    try {
      const brut = localStorage.getItem(CLE); if (!brut) return null;
      const { choix, date } = JSON.parse(brut);
      if ((choix !== 'accepte' && choix !== 'refuse') || typeof date !== 'number' || Date.now() - date > DUREE_MS) return null;
      return choix;
    } catch (e) { return null; }
  };
  const ecrire = (choix) => { try { localStorage.setItem(CLE, JSON.stringify({ choix, date: Date.now() })); } catch (e) { /* stockage bloqué : vaut pour cette page */ } };
  const accord = () => { if (typeof window.bdAnalyticsConsent === 'function') window.bdAnalyticsConsent(); };
  const retrait = () => { if (typeof window.bdAnalyticsRevoke === 'function') window.bdAnalyticsRevoke(); };
  const ouvrir = () => { bandeau.hidden = false; const b = bandeau.querySelector('[data-choix="refuse"]'); if (b) b.focus(); };

  const precedent = lire();
  if (precedent === 'accepte') accord();
  if (precedent === null) bandeau.hidden = false;
  bandeau.addEventListener('click', (e) => {
    const cible = e.target.closest('[data-choix]'); if (!cible) return;
    const choix = cible.dataset.choix, avant = lire();
    ecrire(choix); bandeau.hidden = true;
    if (choix === 'accepte') accord(); else if (avant === 'accepte') retrait();
  });
  document.querySelectorAll('[data-bd-cookies]').forEach(l => l.addEventListener('click', ouvrir));
})();
