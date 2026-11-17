# Carambole — arbitre vidéo (partie libre)

Application qui filme une table de billard français, suit les 3 billes, dit si le point est valide,
classe l'effet du coup (rétro, amorti, naturel, coulé) et évalue le geste (rectitude, régularité).

## Choix matériel
- **Cible principale : smartphone Android** posé sur pied, qui filme la table (vue de dessus ou oblique).
  Il fait tout : capture, analyse et affichage. Il filme à 60–240 images/s, contre ~15 pour une ESP32-CAM.
- Alternatives possibles plus tard : ESP32-CAM (l'ESP8266 n'a pas de caméra) ou Raspberry Pi 3 + module caméra,
  qui enverraient le flux au téléphone. Le moteur ne dépend pas de la source des images.

## Architecture
```
engine.js        Moteur d'analyse en JS pur (navigateur + Node). Aucune dépendance.
test/sim.js      Simulateur : physique du billard + rendu caméra en perspective (images RGBA synthétiques).
test/run.js      Banc d'essai : génère des coups, les passe au moteur, compare à la vérité terrain.
app/index.src.html  Interface mobile (source). Le moteur y est injecté à la place de /*ENGINE*/.
build.js         node build.js → docs/ : index.html autonome (~72 Ko) + fichiers PWA copiés depuis app/pwa/.
app/pwa/         manifest.webmanifest, sw.js (cache réseau d'abord, hors ligne ensuite), icônes 192/512.
test/make_video.js  Rend un coup simulé en MP4 (ffmpeg) pour tester la page.
test/e2e.py      Test de bout en bout : Chrome sans écran (Playwright), calibrage au doigt, import, verdict.
```

## Interface (app/index.src.html)
- Sources : caméra (getUserMedia, 60 i/s demandés, `requestVideoFrameCallback` pour l'horodatage)
  ou vidéo importée (lecture à 0,5× avec pause à chaque image : aucune image sautée ; temps réel = temps vidéo / facteur de ralenti).
- Image analysée réduite à 640 px de large. Calibrage : 4 touches + glisser pour ajuster, coins stockés en coordonnées normalisées.
- Après chaque coup : verdict, séquence, schéma SVG des trajectoires, effet, geste, boutons de correction manuelle.
- Historique et réglages dans localStorage (toujours dans un try/catch : peut être indisponible).
- `window.__carambole` expose le nombre d'images traitées (utilisé par le test e2e).
- **La caméra est bloquée dans une page publiée sur claude.ai** (cadre sécurisé) : là, seul l'import vidéo marche.
  Pour la caméra en direct, héberger `docs/index.html` en HTTPS (GitHub Pages) et l'ouvrir dans Chrome Android.

## Conventions
- Unités : **mètres et secondes**. Repère table : x le long de la grande bande (0..L), y en largeur (0..W).
- Indices des billes : 0 = blanche, 1 = jaune, 2 = rouge (`NAMES`).
- Textes affichés à l'utilisateur en **français**.
- Le moteur doit rester sans dépendance et exporté en UMD (`module.exports` sous Node, `window.CaramboleEngine` dans le navigateur).

## Pipeline du moteur (engine.js)
1. **Calibrage** (`Detector`) : l'utilisateur touche les 4 coins intérieurs (nez de bande), 1 et 2 sur une même grande bande.
   On calcule une homographie image → table. Pour chaque pixel, on précalcule ses coordonnées table
   et une zone (1 = zone des billes élargie de 2,5 cm, 2 = drap strict).
2. **Détection** (`Detector.detect`) : seuils HSV par pixel (blanche = peu saturée et claire, jaune = teinte 38–72°,
   rouge = teinte proche de 0°), puis composantes connexes (union-find). Une tache est gardée si sa surface vaut
   0,28 à 2,8 fois l'aire attendue d'une bille à cet endroit (l'aire varie avec la perspective).
3. **Suivi** (`Session._assign`) : pour chaque couleur, on prend la tache la plus proche de la position prédite
   (position + vitesse × dt), dans une fenêtre qui grandit avec la vitesse.
4. **Découpage des coups** (`Session.process`) : au repos, on garde ~3,6 s d'historique. Un coup commence quand une bille
   s'écarte de plus de 1,2 cm de sa position de repos sur 2 images ; il finit quand tout est immobile pendant 0,45 s.
5. **Analyse du coup** (`analyzeShot`, fonction pure, testable) :
   - interpolation des positions manquantes ;
   - **départ depuis le repos** : 1re image à plus de 8 mm du repos ; l'instant exact du choc est retrouvé en remontant la droite de départ ;
   - **chocs en mouvement** : on compare la vitesse ajustée (régression linéaire sur ~50 ms) avant et après chaque image ;
     un saut de vitesse au-dessus d'un seuil (qui tient compte du frottement) est un choc ;
   - **qui a tapé qui** (`findHitter`) : la bille dont la position extrapolée à l'instant du choc est à ~1 diamètre
     (tolérance 1,42 D) et dans le bon sens de poussée. Sinon, si la bille est contre une bande → **bande** ;
   - **verdict libre** : la bille jouée (la 1re qui part, ou celle réglée par le joueur) doit toucher les deux autres.
     Faute si une bille quitte la table ou si ce n'est pas la bonne bille qui part en premier.
     Si pas de point, on indique à quelle distance la bille manquée est passée ;
   - **confiance** : selon l'écart entre distance mesurée au choc et diamètre, la cadence et les contacts serrés.
6. **Effet** : au 1er choc bille jouée → bille, u = axe des centres, a = vitesse entrante projetée sur u.
   On mesure k = (vitesse de la bille jouée selon u, en fin de glissement) / a.
   Physique : bille qui roule → k = 2/7 ≈ 0,29 ; bille sans rotation (amorti) → k ≈ 0 ; rétro → k < 0 ; coulé → k > 2/7.
   Seuils : rétro < −0,06 ≤ amorti ≤ 0,13 < naturel ≤ 0,37 < coulé.
   Si la trajectoire est interrompue avant la fin du glissement, on utilise l'accélération après le choc
   et l'accélération juste avant le choc (une bille qui accélère encore avant le choc a un excès de rotation → coulé).
   Non classé si la touche est trop fine (a < 0,25 × vitesse) ou la trajectoire trop courte.
7. **Geste** (`Detector.cueFeatures` + `analyzeGesture`) : vue de dessus, la queue est une ligne fine de pixels
   « pas couleur du drap » qui pointe vers la bille. Détection par RANSAC puis ACP, à chaque image avant le coup.
   On en tire : angle de la queue, décalage latéral, distance procédé–bille.
   - rectitude = stabilité de l'angle et du décalage + écart entre l'axe de la queue et le départ réel de la bille ;
   - régularité = constance de la période (hors dernier recul avant la frappe) et de l'amplitude des va-et-vient (série lissée par médiane sur 3, extrema avec hystérésis 2 cm).
   Les détections aberrantes (> 6° de la médiane) sont rejetées ; résultat non fiable si plus de 40 % sont rejetées.

## Installation sur le téléphone (PWA)
Héberger le dossier `docs/` en HTTPS (GitHub Pages : dépôt avec ces 5 fichiers, Settings → Pages → branche main).
Ouvrir l'URL dans Chrome Android → menu ⋮ → « Installer l'application ». Le service worker n'est enregistré qu'en HTTPS ou sur localhost.
Après une mise à jour, incrémenter `CACHE` dans sw.js.

## Tests
```
node test/run.js            # 48 scénarios aléatoires (30, 60, 120 i/s), ~4 min
node test/run.js 26,39      # seulement certains scénarios
node build.js && node test/make_video.js 16 /tmp/coup16.mp4 && python3 test/e2e.py /tmp/coup16.mp4
```
Le simulateur modélise glissement/roulement (μ = 0,2), chocs élastiques, bandes, et dessine la table en perspective
avec bruit, main de pont et queue en mouvement. La 3e bille est placée sur la trajectoire de la bille jouée
(point valide) ou à côté (pas de point). La vérité de l'effet est le k final si la bille avait fini de glisser.

Derniers résultats : verdict 31/31 correct ; effet 28/30 (les 2 erreurs à moins de 0,03 du seuil naturel/coulé) ;
rectitude ~79 (geste régulier) contre ~51 (irrégulier) ; régularité ~92 contre ~70.
Test navigateur : 2 vidéos MP4, verdicts justes, aucune image sautée, aucune erreur console.

## Limites connues
- Calibré sur des images de synthèse : seuils de couleur à ajuster sur une vraie table (lumière, couleur du drap).
- Le centre détecté d'une bille est légèrement décalé en vue oblique (hauteur de la bille ignorée). L'erreur est
  la même pour les 3 billes, donc les distances au choc restent justes.
- Geste peu mesurable quand la bille jouée est près de la bande éloignée (peu de pixels de queue).
- À 30 i/s, les contacts très fins restent incertains : la confiance passe alors à « faible ».

## Prochaines étapes
- Essais sur une vraie table : ajuster les seuils de couleur, vérifier la cadence réelle de la caméra en direct.
- Utiliser les corrections manuelles de l'historique pour régler les seuils (contact, effet).
- Si la cadence du navigateur ne suffit pas : application Android native (CameraX à 120/240 i/s) réutilisant engine.js dans une WebView ou porté en Kotlin.
- Moteur dans un Web Worker si le téléphone n'arrive pas à suivre 60 i/s en direct.
