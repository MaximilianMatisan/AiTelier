# Kontext für Claude Design: das Design der AiTelier-Studio-Website

Diesen Text als Kontext an Claude Design geben. Auftrag: **die ganze Website neu gestalten**,
alle drei Screens, siehe **„Auftrag“** am Ende. Die Seite funktioniert bereits; gesucht ist
das Design, nicht neue Funktionen.

## Produkt in einem Absatz

AiTelier ist ein KI-Agent für den Cardano-Track des TUM Blockchain & AI Hackathons. Eine
Kundin oder ein Kunde gibt Budget, Stil, Saison und Größen ein. Der Agent stellt daraus
Outfits aus **echten Produkten echter Online-Shops** zusammen (Katalog mit 8.725 Artikeln)
und prüft jedes Outfit per Code gegen fünf Garantien: Budget, Passform, Verfügbarkeit,
Preis-Integrität und Lieferung. Bezahlt wird per Escrow auf Cardano. Fällt ein Outfit durch,
gibt es eine Rückerstattung. Grundprinzip: **Die KI entscheidet, der Code prüft.**
Tonalität: ruhig, hochwertig, „Atelier“, kein Tech-Startup-Look.

## Die GUI heute

Lokale Web-App, gestartet mit `npm run ui`, erreichbar unter `http://127.0.0.1:21960`.

| Datei | Inhalt |
|---|---|
| `ui/index.html` | Seite, gesamtes CSS, Seitenlogik (Formular, Polling, Screens) |
| `ui/a2ui.js` | Renderer: zeichnet A2UI-Nachrichten des Agenten als DOM |
| `ui/server.mjs` | lokaler Server: prüft die Bestellung, startet die Pipeline, liefert Bilder aus |

Drei Screens:

1. **Bestellung** (gehört der Seite): Budget, Anzahl Outfits, Stil als Chips
   (Old money, Lässig/casual, Streetwear), Saison, Kollektion, Passform, Klima, Größen
   (Top, Taille in Zoll, Schuhe EU), Ausschlüsse, Schalter „Fast demo mode“.
   Fehler kommen gesammelt vom Server und stehen in einer roten Box.
2. **Warten** (gehört der Seite): fünf Pipeline-Stufen plus „Order checked“, jede
   `pending`, `running` oder `done`, mit Sekundenzähler. Dauer etwa 25–40 s.
3. **Ergebnis** (gehört dem Agenten): Status-Badge (`APPROVED` oder `REFUND`), darunter die
   A2UI-Oberfläche des Agenten, darunter ein aufklappbarer Block mit den rohen A2UI-Nachrichten.

## Das Wichtigste: A2UI

Den Ergebnis-Screen beschreibt der Agent selbst, als **A2UI v0.9.1**-Nachrichten
(Agent-to-User Interface, Basic Catalog). Die Seite hat kein eigenes Outfit-Layout; sie
zeichnet nur, was der Agent schickt. Daraus folgt für jede Komponente im Ergebnis-Screen,
von der einfachsten zur aufwendigsten Variante:

1. **Nur Gestaltung**: eine vorhandene Basic-Catalog-Komponente neu stylen (CSS auf die
   Klassen unten). Am Agenten ändert sich nichts.
2. **Neue Zusammensetzung**: aus vorhandenen Komponenten ein neues Muster bauen, z. B.
   Farbpalette als `Row` aus kleinen `Text`/`Icon`. Dafür muss der Agent (Person 3,
   `person3/app/services/a2ui.py`) diese Struktur senden.
3. **Eigene Katalog-Komponente**: ein neuer Typ wie `OutfitCard`. Dafür sind Renderer,
   Agent und eine eigene Catalog-ID zu ändern. Nur wählen, wenn 1 und 2 nicht reichen.

Formular- und Warte-Screen sind kein A2UI; dort ist alles erlaubt.

### Komponenten, die der Agent heute sendet

| Komponente | Felder | Gerendert als (CSS-Klassen) |
|---|---|---|
| `Text` | `text`, `variant`: `h1` `h2` `h3` `body` `caption` | `h2/h3/h4/p/small.a2ui-text.a2ui-text-{variant}` |
| `Image` | `url`, `description`, `fit` (`cover`/`contain`), `variant` (`largeFeature`, …) | `img.a2ui-image.a2ui-image-{variant}`; ohne Bild `div.a2ui-image-missing` |
| `Card` | `child` | `div.a2ui-card` |
| `Column` / `Row` | `children`, `align` | `div.a2ui-column` / `div.a2ui-row` + `.a2ui-align-{align}` |
| `List` | `children`, `direction` | `div.a2ui-list.a2ui-list-{direction}` |
| `Tabs` | `tabs: [{title, child}]` | `.a2ui-tabs` > `.a2ui-tabbar` (`.a2ui-tab[aria-selected]`) + `.a2ui-tabpanel` |
| `Button` | `child`, `variant` (`primary`, `borderless`), `action.functionCall` `openUrl` | `button.a2ui-button.a2ui-button-{variant}` |
| `Icon` | `name`: `check`, `close`, `warning`, `info` | `span.a2ui-icon.a2ui-icon-{name}` |
| `Divider` | – | `hr.a2ui-divider` |

Die Wurzel heißt immer `root`; Komponenten verweisen über `id` aufeinander (flache Liste).
Das Theme kommt mit: `primaryColor: #1F2A44`, `agentDisplayName: "AiTelier Stylist"`.

### Echter Ausschnitt (ein Outfit, gekürzt)

```json
{"id": "root", "component": "Column", "align": "stretch",
 "children": ["header", "summary", "gallery", "lookbook", "decision", "warnings"]}

{"id": "outfit_0", "component": "Card", "child": "outfit_0_body"}
{"id": "outfit_0_body_board", "component": "Image", "variant": "largeFeature", "fit": "cover",
 "url": "http://127.0.0.1:21960/artifacts/aitelier-catalog-demo/look-1-board.jpg",
 "description": "Refined Old Money product board"}
{"id": "outfit_0_body_name", "component": "Text", "variant": "h2", "text": "Refined Old Money"}
{"id": "outfit_0_body_total", "component": "Text", "variant": "body", "text": "Total: 442.40 EUR · 4 layers"}
{"id": "outfit_0_body_rationale", "component": "Text", "variant": "caption",
 "text": "A sophisticated, tonal approach to the old money aesthetic, layering a crisp long-sleeve polo under a breathable knit polo for textural depth, paired with classic navy chinos and premium suede loafers."}
{"id": "outfit_0_body_tabs", "component": "Tabs", "tabs": [
  {"title": "Base — Polo manga larga blanco", "child": "outfit_0_body_layer_0"},
  {"title": "Shoes — Easy Weejuns Larson Penny Loafers for Men (262 / M / CHOCOLATE)", "child": "outfit_0_body_layer_3"}]}
{"id": "outfit_0_body_layer_0", "component": "Column", "align": "start",
 "children": ["…_image", "…_title", "…_detail", "…_link"]}
{"id": "…_detail", "component": "Text", "variant": "body", "text": "Size M · 59.90 EUR"}
{"id": "…_link", "component": "Button", "variant": "borderless", "child": "…_link_text",
 "action": {"functionCall": {"call": "openUrl", "args": {"url": "https://silbonshop.com/products/polo-manga-larga-blanco"}}}}
{"id": "outfit_0_body_guarantees_row_0", "component": "Row", "align": "center",
 "children": ["…_icon_0", "…_text_0"]}
{"id": "…_icon_0", "component": "Icon", "name": "check"}
{"id": "…_text_0", "component": "Text", "variant": "body", "text": "Budget: OK — 442.40 EUR <= 500.00 EUR"}

{"id": "decision", "component": "Text", "variant": "h3", "text": "Approved: all five guarantees passed."}
```

Ein Outfit besteht aus etwa 47 Komponenten. Zusätzlich sendet der Agent per
`updateDataModel` die Rohdaten jedes Outfits:

```json
{"outfit_id": "look-1", "name": "Refined Old Money", "style_blend": ["old money"],
 "totals": {"items": 392.4, "shipping": 50.0, "grand_total": 442.4, "currency": "EUR"},
 "rationale": "…", "fit_notes": "…", "confidence": 0.86, "color_palette": [],
 "items": [{"item_id": "silbon-…", "title": "Polo manga larga blanco", "brand": "false",
            "layer": "base", "layer_label": "Base", "size": "M",
            "price": {"amount": 59.9, "currency": "EUR"},
            "product_url": "https://…", "image_url": "https://cdn.shopify.com/…"}],
 "guarantees": {"ok": true, "checks": {
   "budget": {"ok": true, "detail": "442.40 EUR <= 500.00 EUR"},
   "fit": {"ok": true, "detail": "…"}, "availability": {"ok": true, "detail": "…"},
   "price_integrity": {"ok": true, "detail": "…"}, "delivery": {"ok": true, "detail": "…"}}}}
```

## Design-Tokens (aus `ui/index.html`)

| Token | Wert | Verwendung |
|---|---|---|
| `--ink` | `#1f2a44` | Text, Primärfarbe (= A2UI `primaryColor`) |
| `--ink-soft` | `#4a5571` | Sekundärtext |
| `--paper` | `#f7f3ec` | Seitenhintergrund |
| `--card` | `#fffdf9` | Karten |
| `--line` | `#e4dccd` | Rahmen, Trennlinien |
| `--gold` | `#a8844c` | Fokus, Akzent, „läuft“ |
| `--ok` / `--warn` / `--bad` | `#2f6b4f` / `#9a5b13` / `#9b2c2c` | Garantie bestanden / Refund / Fehler |

- Schrift: Überschriften Serif (`"Iowan Old Style", Georgia, serif`, Gewicht 500),
  Fließtext `system-ui`. Keine Webfonts nötig.
- Radien: Karten 14px, Felder 8px, Chips und Buttons voll rund (999px).
- Abstände: Karten-Innenabstand 18–24px, Seitenrand 16px, maximale Breite 860px.
- Nur Light Mode.

## Technische Rahmenbedingungen

- Vanilla HTML, CSS und JavaScript (ES-Module). Kein Framework, kein Build-Schritt, keine
  neuen Abhängigkeiten.
- CSS kommt in den `<style>`-Block von `ui/index.html`; neue A2UI-Darstellung kommt als
  `case` in `draw()` in `ui/a2ui.js`.
- Sicherheit: Text nur über `textContent`, nie `innerHTML`. Bilder nur aus http(s) oder vom
  eigenen Server. Aktionen nur `openUrl` auf http(s).
- Muss bei 375px Breite ohne horizontales Scrollen funktionieren.
- Barrierefreiheit: echte Labels, `role`/`aria-selected` bei Tabs, sichtbarer Fokus,
  `prefers-reduced-motion` respektieren.

## Echte Daten, mit denen die Komponente umgehen muss

- **Lange Produkttitel**, z. B. „Easy Weejuns Larson Penny Loafers for Men (262 / M / CHOCOLATE)“.
- **Gemischte Sprachen** aus den Shops: „Polo manga larga blanco“, „Short Bodhi argile“.
- **Fehlende Marke**: manche Artikel haben die Marke `"false"` (Datenfehler, wird behoben).
- **Bilder können fehlen** oder nicht laden; das Bild-Board ist hochformatig.
- **`color_palette` ist oft leer.** Seit Commit `8a93fdf` beginnt das `rationale` mit der
  Palette („Palette: navy, cream, tan. …“); ältere Ergebnisse wie der Ausschnitt oben noch nicht.
- **Warnungen** wiederholen sich, z. B. 20× `GUARANTEE_ASSUMED`.
- **Refund-Fall**: `status: "REFUND"`, keine Outfits, eine Begründung, z. B.
  „look-1 budget: 373.88 EUR <= 300.00 EUR“.
- 1 bis 10 Outfits mit je 3 bis 5 Teilen (base, mid, outer, bottom, shoes).

## Was beim Redesign gleich bleiben muss

Die Seitenlogik in `ui/index.html` und der Server hängen an diesen Stellen. Aussehen,
Reihenfolge und Markup drumherum sind frei; diese Haken nicht.

- **Screens**: drei `<section>` mit den IDs `order`, `progress` und `result`. Es ist immer
  genau einer sichtbar; die Logik schaltet über das Attribut `hidden` um.
- **Formular** `#form` mit Absende-Button `#submit` und Fehlerbox `#form-errors`. Die
  Feldnamen gehen 1:1 an den Server:

  | `name` | Typ | Werte |
  |---|---|---|
  | `budget_eur` | Zahl | 1–10000, Euro |
  | `outfits` | Zahl | 1–10 |
  | `theme` | genau eine Auswahl | `old_money`, `casual`, `streetwear` |
  | `season` | Auswahl | `autumn`, `winter`, `spring`, `summer` |
  | `gender` | Auswahl | `men`, `women` |
  | `fit`, `climate` | Text, optional | frei, kurz |
  | `top` | Auswahl | `XS`, `S`, `M`, `L`, `XL`, `XXL` |
  | `waist` | Zahl | 24–50, Zoll |
  | `shoe_eu` | Zahl | 34–50, halbe Größen erlaubt |
  | `avoid` | Text, optional | kommagetrennt |
  | `fast` | Checkbox | an = Demo-Shortlist, etwa 30 s |

- **Warten**: Liste `#steps` und Zähler `#elapsed`. Die Logik baut die Einträge selbst, als
  `<li class="done|running|pending">` mit `<span class="dot">` und darin `<strong>`
  (Titel) und `<small>` (Erklärung). Das Aussehen dieser Klassen ist frei. Fehlerfall:
  `#run-error` mit `#run-log`.
- **Ergebnis**: `#badge` bekommt die Klasse `badge APPROVED` oder `badge REFUND`,
  `#refund-note` erscheint nur bei Refund, `#surface` ist der Container, in den der
  A2UI-Renderer zeichnet, `#raw` zeigt die rohen A2UI-Nachrichten.
- Buttons mit dem Attribut `data-restart` führen zurück zum Formular.

## Auftrag

**Gestalte die ganze Website des AiTelier Studios neu**: Bestellung, Warten, Ergebnis,
dazu Kopf- und Fußbereich. Ziel ist eine Demo, die in den ersten fünf Sekunden „hochwertiges
Atelier“ ausstrahlt und gleichzeitig zeigt, dass hier geprüft und auf Cardano bezahlt wird.

Pro Screen:

1. **Bestellung**: soll sich wie ein Gespräch mit einem Schneider anfühlen, nicht wie ein
   Behördenformular. Stilwahl visuell statt als Text-Chips. Größen klar gruppiert. Der
   Schalter „Fast demo mode“ bleibt sichtbar, darf aber zurücktreten. Fehler vom Server
   erscheinen gesammelt.
2. **Warten**: 25–40 Sekunden, die sich lohnen. Die fünf Stufen sollen zeigen, was gerade
   passiert („Removing sizes you cannot buy“) und dass Code prüft. Kein Fake-Fortschritt:
   der Zustand kommt nur aus den Klassen `done`, `running` und `pending`.
3. **Ergebnis**: gestalte alle A2UI-Basic-Catalog-Komponenten aus der Tabelle oben als
   zusammenhängendes Designsystem (Variante 1, nur CSS). Das ist der Pflichtteil.
   Wenn ein besseres Ergebnis nur mit neuer Struktur geht, etwa eine Outfit-Karte mit
   allen Teilen auf einen Blick statt hinter Tabs, liefere das als Vorschlag mit dem
   A2UI-JSON, das der Agent dafür senden müsste (Variante 2 oder 3). Status `APPROVED` und
   `REFUND` müssen klar unterscheidbar sein; der Refund-Fall ist ein Schutz, kein Fehler.

Die Tokens oben sind der Ausgangspunkt, kein Zwang; ein eigenes, besseres System ist
willkommen, solange Text auf Hintergrund mindestens WCAG AA erreicht.

**Erwartetes Ergebnis von Claude Design:**

- Eine vollständige `index.html` mit allen drei Screens und eingebettetem CSS, die die
  Haken aus „Was beim Redesign gleich bleiben muss“ unverändert enthält. Den
  `<script type="module">`-Block der bestehenden Datei darf sie übernehmen, statt ihn
  neu zu schreiben.
- CSS für alle `a2ui-*`-Klassen aus der Komponententabelle.
- Optional: Vorschläge für neue A2UI-Strukturen mit Beispiel-JSON.
- Zustände: leeres Formular, Formular mit Fehlern, jede Wartestufe, `APPROVED` mit
  1 und mit 3 Outfits, `REFUND`, fehlendes Bild, sehr langer Produkttitel, mobil (375px).
