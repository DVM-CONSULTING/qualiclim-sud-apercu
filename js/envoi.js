/*!
 * Qualiclim Sud — envoi des demandes (formulaire de contact et simulateur).
 *
 * Contrat du relais de formulaire Belle Devanture (Worker mutualisé « formulaire » de l'usine) :
 *   POST <adresse>/f/<slug>  en JSON : nom, telephone, email, message, _slug, _ts, site_web (champ piège).
 *   Réponse { ok: true } seulement quand la demande est réellement partie.
 * L'adresse et le slug viennent de la configuration (outils/fabriquer.mjs → <meta name="qs-formulaire">).
 *
 * Standard Belle Devanture : bdFormSent(nom) SEULEMENT après la réponse { ok: true } ; bdFormFailed(nom) sinon.
 * Tant que l'adresse n'est pas renseignée, rien n'est envoyé et la page le dit : on ne fait jamais croire
 * qu'une demande est partie.
 * credentials 'same-origin' : un relais sur le domaine du site (VPS) reçoit le mot de passe de l'aperçu
 * comme le reste de la page ; un relais sur un autre domaine (Worker) ne reçoit jamais d'identifiants.
 */
(() => {
  'use strict';
  const meta = document.querySelector('meta[name="qs-formulaire"]');
  const adresse = meta ? (meta.getAttribute('content') || '').trim().replace(/\/+$/, '') : '';
  const slug = meta ? (meta.getAttribute('data-slug') || '') : '';
  const debut = Date.now();
  const signal = (fn, nom) => { try { if (typeof window[fn] === 'function') window[fn](nom); } catch (e) { /* le kit ne doit jamais casser l'envoi */ } };

  async function envoyer(champs, nom) {
    if (!adresse || !slug) return { ok: false, nonRelie: true };
    const corps = { nom: champs.nom || '', telephone: champs.telephone || '', email: champs.email || '', message: champs.message || '', _slug: slug, _ts: String(debut), site_web: champs.site_web || '' };
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const minuteur = ctrl ? setTimeout(() => ctrl.abort(), 15000) : 0;
    try {
      const r = await fetch(`${adresse}/f/${encodeURIComponent(slug)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corps), signal: ctrl ? ctrl.signal : undefined, credentials: 'same-origin' });
      let donnees = null; try { donnees = await r.json(); } catch (e) { donnees = null; }
      if (r.ok && donnees && donnees.ok === true) { signal('bdFormSent', nom); return { ok: true }; }
      signal('bdFormFailed', nom);
      return { ok: false, erreurs: donnees && Array.isArray(donnees.erreurs) ? donnees.erreurs.slice(0, 3) : [] };
    } catch (e) {
      signal('bdFormFailed', nom);
      return { ok: false, erreurs: [] };
    } finally { if (minuteur) clearTimeout(minuteur); }
  }
  window.QualiclimEnvoi = { envoyer, relie: () => Boolean(adresse && slug) };
})();
