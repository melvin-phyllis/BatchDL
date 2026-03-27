# BatchDL

Application **bureau** (Windows / macOS) pour **télécharger des fichiers par lots** : file d’attente, progression, pause / reprise / nouvelle tentative, et prise en charge de certains hébergeurs qui exigent une étape navigateur (résolution d’URL dans un Chromium intégré).

Stack : **Electron** · **React** · **TypeScript** · **Vite** · **Tailwind CSS**.

### Pourquoi ce projet ?

J’en avais marre de télécharger **plus d’une centaine de fichiers un par un**, alors j’ai créé BatchDL pour **m’en faciliter la vie**. En pratique : vous **copiez la liste de liens**, vous la **collez dans le logiciel**, vous **choisissez le dossier de destination**, et c’est tout.

**Sites avec lesquels ça fonctionne bien actuellement** (hébergeurs testés et pris en charge de façon fiable à ce jour) :

| Site | Remarque |
|------|----------|
| **[datanodes.to](https://datanodes.to)** | Passage par un navigateur intégré (délais / page du site). |
| **[fuckingfast.co](https://fuckingfast.co)** | Résolution de la page puis lien de téléchargement. |

D’autres URLs (lien direct HTTP(S), certains tunnels) peuvent aussi marcher ; les détails techniques sont dans la section **Hébergeurs / types d’URL** (plus bas, sous *Utilisation*).

---

## Prérequis

| Outil | Version recommandée |
|--------|----------------------|
| [Node.js](https://nodejs.org/) | **20 LTS** ou **22** (avec npm) |
| Git | optionnel (cloner le dépôt) |

Sous **Windows**, un build des installateurs peut nécessiter des outils de build pour les modules natifs (souvent déjà couverts par les binaires précompilés). En cas d’erreur à l’installation, installez [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (charge de travail « Développement Desktop en C++ »).

---

## Installation (pour développer ou lancer depuis les sources)

```bash
# À la racine du projet (clone Git ou archive décompressée)
cd batchdl
npm install
```

La première installation télécharge notamment **Puppeteer** et une **Chromium** compatible — comptez plusieurs centaines de Mo d’espace disque.

---

## Développement

Lance le **renderer** (Vite), la **compilation Electron** en mode watch, puis la **fenêtre Electron** une fois le serveur et `dist-electron/` prêts :

```bash
npm run dev
```

- Interface : [http://localhost:5173](http://localhost:5173) (chargée par Electron en dev).
- Si la fenêtre reste vide : vérifiez que `dist-electron/main.js` et `dist-electron/preload.js` existent (le script `dev:main` les régénère).

Autres commandes utiles :

| Commande | Rôle |
|----------|------|
| `npm run build:renderer` | Build production du front (`dist/`) |
| `npm run build:electron` | Compile `main.ts`, `preload.ts`, `utils/` → `dist-electron/` |
| `npm run build` | Renderer + Electron |
| `npm run typecheck` | Vérification TypeScript sans écrire de fichiers |
| `npm run dist` | Build + **electron-builder** → installateurs dans `release/` |

---

## Build & installateurs

```bash
npm run build
npm run dist
```

Les artefacts sont générés dans le dossier **`release/`**.

---

## Créer un .exe pour Windows (sans Node pour les utilisateurs finaux)

**Une seule personne** (vous ou l’équipe qui maintient le projet) doit avoir Node.js installé. Les **utilisateurs finaux** n’ont **pas besoin** de npm ni du code source : ils reçoivent uniquement un fichier généré dans `release/`.

### 1. Sur une machine Windows (64 bits)

À la racine du projet, après `npm install` :

```bash
npm run dist
```

Cela compile l’app puis lance **electron-builder**. Dans `release/`, vous obtenez typiquement :

| Fichier (exemple de noms) | Usage |
|---------------------------|--------|
| **`BatchDL Setup 1.0.0.exe`** | **Installateur NSIS** : double-clic → installation (raccourcis, désinstallateur Windows). À privilégier pour la plupart des gens. |
| **`BatchDL 1.0.0.exe`** (cible **portable**) | **Version portable** : pas d’installation classique ; l’utilisateur lance ce `.exe` directement (pratique sur clé USB ou si on ne veut pas d’installeur). Le numéro de version suit `package.json`. |

Les noms exacts peuvent légèrement varier selon la version dans `package.json`.

### 2. Ce que vous distribuez

- Envoyez **soit** l’installateur **`Setup`**, **soit** la version **portable** (ou les deux).
- Les destinataires **double-cliquent** sur le `.exe` — **aucune** commande `npm` ni installation de Node n’est requise chez eux.

### 3. Taille et antivirus

- Le paquet fait souvent **plusieurs centaines de Mo** (Electron + Chromium pour Puppeteer). C’est normal.
- Un antivirus peut analyser longtemps la première exécution ; en cas de faux positif rare, signalez-le à l’éditeur de l’AV.

### 4. macOS

Sur un Mac, `npm run dist` produit un **`.dmg`** dans `release/` (même idée : fichier à transmettre, pas besoin de Node chez l’utilisateur).

---

## Utilisation (utilisateur final)

1. **Choisir un dossier de destination** (bouton dédié dans l’interface).
2. **Coller une ou plusieurs URLs** HTTP/HTTPS (une par ligne ou selon l’UI).
3. Régler si besoin la **concurrence** (téléchargements en parallèle) et un **délai** entre le démarrage des tâches.
4. Lancer les téléchargements et suivre la **file** (actifs, terminés, erreurs).

Fonctions courantes :

- **Pause / annulation** d’une tâche en cours (selon l’état affiché).
- **Réessayer** après une erreur.
- Barres de **progression** et indication de **débit** quand le serveur fournit la taille du fichier.

### Hébergeurs / types d’URL

- **Liens directs** ou domaines reconnus comme **tunnel de téléchargement** : téléchargement direct avec les en-têtes adaptés.
- **`fuckingfast.co`** : résolution de la page puis lien `/dl/…`.
- **`datanodes.to`** : le flux passe par un **navigateur headless** (Puppeteer + plugin stealth) pour respecter le site (cookies Cloudflare, compte à rebours Vue, POST vers `/download`, etc.). Le premier lancement peut être un peu plus long (démarrage de Chromium).

Les sites tiers peuvent changer à tout moment ; l’outil est fourni **tel quel**, sans garantie de compatibilité permanente.

---

## Fichiers de log

Les journaux sont écrits dans le répertoire **données utilisateur** de l’application, par exemple :

- **Windows** : `%APPDATA%\batchdl\logs\batchdl.log`

En cas de problème avec **datanodes**, une capture **`datanodes-debug.png`** peut être créée dans le même dossier utilisateur (`%APPDATA%\batchdl\`).

---

## Dépannage

| Problème | Piste |
|----------|--------|
| `npm install` échoue | Mettre à jour Node/npm ; sous Windows, voir les prérequis de build ci-dessus. |
| Écran blanc en `npm run dev` | Attendre la fin de `tsc` ; vérifier la présence de `dist-electron/preload.js` et `main.js`. |
| Téléchargement datanodes qui échoue | Consulter `batchdl.log` et éventuellement `datanodes-debug.png` ; vérifier que l’URL est encore valide. |
| Installateur volumineux | Normal : Electron + Chromium embarqué pour Puppeteer augmentent la taille du paquet. |

---

## Structure du dépôt (aperçu)

```
batchdl/
├── main.ts              # Process principal Electron (file, IPC, résolution d’URL)
├── preload.ts           # Pont sécurisé renderer ↔ main
├── renderer/            # Interface React (Vite)
├── utils/               # Téléchargement HTTP, résolveurs (ex. datanodes + Puppeteer)
├── shared/              # Types partagés
├── build/               # Icônes / ressources build
└── dist/ / dist-electron/   # Sorties de build (générées)
```

---

## Licence

Voir le champ `license` dans `package.json` (par défaut **ISC** si non modifié). Ajoutez un fichier `LICENSE` si vous publiez le projet publiquement.

---

## Contribution

Les suggestions et correctifs sont les bienvenus : issues, pull requests, ou fork pour adapter BatchDL à vos besoins.
