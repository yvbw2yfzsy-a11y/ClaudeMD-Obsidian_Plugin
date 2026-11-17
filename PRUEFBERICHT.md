# Prüfbericht: Claude Markdown Viewer 1.1.0 bis 2.0.0

Geprüft wurden `main.js`, `styles.css`, `manifest.json` und `README.md` aus `claude-markdown-viewer-1.1.0.zip` sowie die drei Testdateien. Eine Anleitung, ein Prüfbericht oder die ursprüngliche Anfrage lagen nicht bei und sind deshalb nicht geprüft. Behauptungen in README und Code-Kommentaren wurden als Behauptungen behandelt.

## Stand 2.0.0: nur noch eine Darstellung

Auf Wunsch gibt es nur noch eine Darstellung, die immer alles fertig zeigt. Entfernt wurden die drei Darstellungen (wie Claude Docs, wie Claude-Chat, Norm), Augen-Symbol, Befehle, Block-Umschalter, Docs-Erkennung, eigene Zeilenumbruch-Logik (Obsidian-Einstellung „Strenge Zeilenumbrüche“ regelt das), `www.`-Verlinkung (Obsidian verlinkt selbst, in der Leseansicht am iPad gesehen), Tags und `==` als Text, alle Einstellungen außer „Nur ansehen“. `main.js` schrumpft von rund 3060 auf rund 1950 Zeilen.

Neu dargestellt:

- Maskierte Formatierungen aus Docs-Exporten: `\<u>`, `\<sub>`, `\<sup>`, `\<mark>`, `\<kbd>`, `\<b>`/`\<strong>`, `\<i>`/`\<em>`, `\<s>`/`\<del>`, `\<ins>`, `\<small>`, `\<details>`/`\<summary>`. `\<br>` bleibt Text (zu oft in Erklärungen gemeint). `&#10;` zwischen `<details>` und `<summary>` wird zu einem Leerzeichen; die Zeilenzahl bleibt gleich, damit die Abschnitte zu Obsidians Zählung passen.
- `> &#91;!NOTE\]` als Hinweisbox.
- `<img src>` mit relativem Pfad: Das Plugin sucht die Datei relativ zur Markdown-Datei, sonst über Obsidians Link-Auflösung.
- Code-Block `svg` als Grafik, über eine data:-Adresse in `<img>`. Darin laufen keine Skripte.

Bewusst nicht dargestellt:

- Ganze LaTeX-Dokumente (`\documentclass` …): Obsidians Formel-Engine (MathJax) setzt nur Formeln. Es gibt keinen Weg ohne LaTeX-Programm; das Plugin zeigt den Quelltext mit Hinweis.
- `\[\[Wikilink\]\]` aus Docs-Exporten: Daraus würde ein Link auf eine nicht vorhandene Notiz.
- Code-Block `html`: Darstellung bräuchte einen abgeschotteten Rahmen ohne Skripte; meist ist er als Code gemeint.

Abwägung: Der Docs-Export maskiert echte Formatierung und wörtlich getippte Tags gleich. Getippter Text „\<u>…\</u>“ erscheint deshalb jetzt unterstrichen statt als Text.

Regressionstests: 25, alle bestanden. Typprüfung (strict) ohne Fehler. Simulation: In Test 2 erscheinen „unterstrichen“, H₂O, x², die NOTE-Hinweisbox und der Klappbereich „Ausklappbar“ dargestellt; Test 1 unverändert.

## Stand 1.2.1: Leseansicht am iPad ohne Plugin

Die zweiten Screenshots zeigen beide Testdateien in der Leseansicht (Stift-Symbol oben rechts), ohne Plugin. Damit sind mehrere Punkte belegt, die vorher nur vermutet oder nur im Bearbeitungsmodus gesehen waren:

| Beobachtung (Leseansicht, ohne Plugin) | Folge |
| --- | --- |
| „Prozent 50 %% sowie [[Wikilink]] und #tag.“ steht vollständig da, der Rest der Datei ebenfalls. Ein einzelnes `%%` ist hier **Text**, kein Kommentar. | **K1 war falsch eingeordnet.** Nur der Bearbeitungsmodus färbt den Rest grau. 1.2.0 behandelte ein einzelnes `%%` als Kommentar bis Dateiende und baute den ganzen Rest von Test 2 als einen Block neu. Das sah gleich aus, war aber unnötig. 1.2.1 neutralisiert nur noch `%%`-Paare. |
| `<details>` in Test 1: Titel zugeklappt, der Inhalt (Fett, Liste, Code, Formel, Tabelle) steht trotzdem sichtbar darunter. | Bestätigt: Ohne Umbau zerfällt `<details>` mit Leerzeilen. Der Umbau zum Klappbereich ist nötig. |
| `> &#91;!NOTE\] GitHub-Hinweisbox.` bleibt Zitat mit Text „[!NOTE] …“. | Offene Frage beantwortet: wird keine Hinweisbox, passt zu Claude Docs. |
| `www.example.com` ist ein Link mit Symbol für externe Links. | Obsidian verlinkt `www.` selbst; Einstellungstext korrigiert. Das Plugin überspringt bestehende Links, doppelt wird nichts. |
| Fußnoten: `[1]` hochgestellt als Link, Liste mit ↩ am Ende. | Die neu dargestellten Abschnitte des Plugins zeigten nur „1“ mit Tooltip. Tooltips gibt es auf dem iPad nicht. 1.2.1: `[1]`, Tippen springt zur Fußnote oder zeigt ihren Text. |
| `#tag` als Tag-Pille, `==markiert==` markiert, `\<u>…\</u>` als Text, IMPORTANT/CAUTION in Tipp-/Warnfarben, `\(…\)`, `\[…\]` und `math` roh. | Wie erwartet; das Plugin behandelt genau diese Stellen. |

Regressionstests: 21, alle bestanden. Typprüfung ohne Fehler.

## Stand 1.2.0: Nachtrag nach den ersten iPad-Screenshots (Bearbeitungsmodus)

> Korrektur: Diese Screenshots zeigten den Bearbeitungsmodus. Die Aussage „K1 bestätigt“ gilt nur dort; in der Leseansicht ist ein einzelnes `%%` Text (siehe Stand 1.2.1).

Die Screenshots zeigen beide Testdateien **ohne Plugin im Bearbeitungsmodus (Live Preview)**, nicht in der Leseansicht. Erkennbar am Buch-Symbol oben rechts (es schaltet *zur* Leseansicht) und an den Fußnoten, die als `[^1]` im Text und als `¹ Text` an ihrer Stelle stehen statt als Liste am Dateiende. Das Plugin arbeitet nur in der Leseansicht und erzwingt sie. Die Darstellung ist auf iPad und Mac dieselbe; das Plugin läuft auf beiden (`isDesktopOnly: false`).

Was die Screenshots belegen:

- **K1 bestätigt.** In Test 2 ist ab „Prozent 50 %%“ der ganze Rest der Datei grau: Obsidian behandelt alles danach als Kommentar. Deshalb erscheinen dort auch die Tabellen als Rohtext und `&#91;` unaufgelöst. Das sind keine eigenen Fehler, sondern Folgen des Kommentars.
- **IMPORTANT und CAUTION** erscheinen ohne Plugin in den Farben von Tipp und Warnung. Das Plugin färbt sie wie GitHub.
- **`\(…\)`, `\[…\]`, ```` ```math ````, `<details>` mit Markdown** sind ohne Plugin roh. Genau das baut das Plugin um.
- **`www.example.com`** verlinkt Obsidian im Bearbeitungsmodus selbst. Für die Leseansicht ist das nicht belegt; das Plugin überspringt bestehende Links, doppelt wird also nichts.

### Behoben in 1.2.0

| Fund | Änderung |
| --- | --- |
| K1 `%%` | Kommentarbereiche werden wie Klappbereiche behandelt: Der erste Abschnitt zeigt den ganzen Bereich, `%%` steht als `&#37;&#37;` im Text, die übrigen Abschnitte sind ausgeblendet. Funktioniert, ob Obsidian den Bereich in viele Abschnitte teilt oder in einen (beides simuliert). Gilt auch für die Vorschau von `markdown`-Blöcken. |
| M1 Eigenschaften | In der Leseansicht und in der Eigenschaften-Seitenleiste nicht anklickbar, kein Fokus, keine Eingabe. Links und Ein-/Ausklappen bleiben. |
| M2 Checkbox per Tastatur | Klick-Ereignis auf Checkboxen wird abgefangen, auch wenn es von der Leertaste kommt. |
| M3 Sprachkonflikt | Jede Code-Sprache einzeln registriert, Fehler abgefangen, Hinweis beim Start. |
| M4 Fließtext-`<details>` | `<details>` muss allein oder mit `<summary>` auf der Zeile stehen; im Inneren zählen nur Tags am Zeilenanfang bzw. -ende. |
| G4 `<details>` in Liste | Einrückung bleibt erhalten, der Klappbereich bleibt im Listenpunkt. |
| G5 „2024. Jahr“ | Nummer ≠ 1 nach einer Absatzzeile gilt nach CommonMark als Absatztext. |
| G9 Fußnoten | Tooltip mit allen Zeilen einer mehrzeiligen Fußnote. |
| G10 `#tag`, `==` | `#wort` als Text; `==wort==` als Text bei Chat/Code und Norm, nicht bei Docs-Exporten und nicht, wenn die Datei ein wörtliches `<mark>` enthält. Eine Einstellung für `%%`, `#` und `==`. |
| G11 Docs-Merker | Ein kürzerer Text (Ausschnitt) überschreibt nie die Erkennung aus der ganzen Datei; nach jeder Dateiänderung neu bestimmt. |
| G12 Aufräumen | Interne Merker wandern beim Umbenennen mit. |
| G13 Docs-Ordner | Speichern erst nach einer Tipp-Pause; Groß- und Kleinschreibung egal. |
| G14 Platzhalter-Text | Unbelegten Export-Tipp entfernt. |
| G16 Kontextmenü | Auf einem Link zu einer fehlenden Datei gesperrt, Hinweis wie beim Klick. |
| G18 Slug `x²` | Wie github-slugger. |
| neu | Ankerlinks auf Überschriften in Klapp- oder Kommentarbereichen suchen die Überschrift im DOM, klappen nötige Bereiche auf und scrollen hin (vorher landete der Sprung im ausgeblendeten Abschnitt). Test 2: „Sprung zu Tabellen“. |

Regressionstests (Stand 1.2.0): `node tests/regression.js`, 19 Tests, alle bestanden; darunter ein Durchlauf von `processSection` mit Plugin-Instanz für den `%%`-Fall. Typprüfung weiter ohne Fehler.

### Nicht behoben, mit Grund

- **G6 Heuristik `\(…\)`:** `\(Beispiel\)` und `C:\(x86\)` werden Formel. Das tut die Formel-Erkennung im Claude-Chat (KaTeX) nach meinem Wissen genauso, also ist es „wie Claude“. `\(x\)2` und `\(5\)$` sind extrem selten; ein Fix bräuchte unsichtbare Trennzeichen im Text. `\(x|y\)` in Tabellen bricht auch bei GitHub und Claude die Zelle.
- **G7 `\[…\]` mit Listenzeile darin:** selten; ein Fix bräuchte dieselbe Bereichslogik für Formeln, mit Regressionsrisiko.
- **G8 Docs-Erkennung über Datumszeile:** Heuristik, nicht eindeutig richtig oder falsch. Abhilfe gibt es schon: Ordner-Einstellung und Augen-Menü.
- **G15 `<details>` in Zitaten:** selten; Umbau innerhalb von `>`-Zeilen ist fehleranfällig.
- **G17 Norm/Claude-Umschalter:** verliert nur eine bewusst falsche Wahl („wie Docs“ bei einer Chat-Datei). Kein Datenverlust; würde ein neues Feld in den gespeicherten Daten brauchen.
- **G19 Canvas:** Notizkarten in Canvas sind bearbeitbar. Canvas gehört nicht zum Ziel (nur Markdown ansehen); Sperren würde Canvas unbenutzbar machen.
- **Datei-Einstellungen beim Löschen aufräumen:** absichtlich nicht. Manche Programme speichern über „löschen und neu anlegen“ oder Sync; dann ginge die eigene Darstellung einer Datei verloren. Übrig gebliebene Einträge sind harmlos.
- **`\<u>…\</u>`, `H\<sub>2\</sub>O`, `\<details>&#10;…` im Docs-Export:** Der Export maskiert genau das, was Claude Docs wörtlich zeigt (wie `&#91;!NOTE\]`). Am wahrscheinlichsten stand dort im Doc wörtlicher Text. Ein Entmaskieren würde etwas rendern, das Docs nicht rendert. Falls das im Doc echte Formatierung war, kann ich es nachrüsten.
- **`[[…]]` als Text:** Im DOM ist ein Wikilink nicht von einem normalen Markdown-Link auf eine Datei zu unterscheiden. Im Docs-Export ist `[[` ohnehin maskiert.
- **Eigenschaften-Übersicht aller Dateien (Seitenleiste „Alle Eigenschaften“):** Umbenennen dort ändert viele Dateien. Sperren würde die Ansicht unbrauchbar machen; sie öffnet sich nur auf ausdrücklichen Befehl.

### Nur in Obsidian prüfbar (zusätzlich zu den Punkten unten)

- Ob Obsidians Klassennamen stimmen: `.metadata-container`, `.metadata-properties-heading`, Seitenleisten-Typ `file-properties`. Stimmen sie nicht, wirkt die Eigenschaften-Sperre nicht, schadet aber nichts.
- Ob `&#37;&#37;` in der Leseansicht als „%%“ erscheint (nach CommonMark ja).
- Ob Obsidian Tags als `<a class="tag">` und `==` als `<mark>` ausgibt (nach meinem Wissen ja).

---

Die folgenden Abschnitte beschreiben die Prüfung von 1.1.0 und die Korrekturen in 1.1.1.

## Was ausgeführt wurde

- **Typprüfung:** `tsc --checkJs` im Strict-Modus gegen `obsidian.d.ts` aus dem npm-Paket `obsidian@1.14.4`. Ergebnis: 0 Fehler. Damit existieren alle öffentlichen Obsidian-Schnittstellen, die das Plugin aufruft, mit den verwendeten Signaturen.
- **Reine Funktionen:** `main.js` in Node 22 geladen, das Modul `obsidian` durch eine Attrappe ersetzt, die Funktionen über `__test` aufgerufen.
- **Abschnitts-Simulation:** `processSection()` nachgebaut. Die Abschnittsgrenzen der Leseansicht wurden mit markdown-it angenähert (Top-Level-Blöcke). Das ist eine Näherung: Obsidian teilt selbst und behandelt z. B. Frontmatter anders.
- **DOM-Hilfen** (`linkifyWww`, Platzhalter, Fußnoten, Tabellen) mit jsdom.
- **Klick-Handler:** echte Plugin-Instanz mit Attrappe für `app` und Ansicht.
- **Slugs:** Abgleich mit dem npm-Paket `github-slugger@2`.
- **Dateizugriffe:** Suche nach `vault.modify`, `process`, `create`, `adapter`, `saveData` usw.

Nicht ausführbar war echtes Obsidian. Alles, was vom Verhalten der Obsidian-Leseansicht abhängt, ist unten als „nur in Obsidian prüfbar“ oder „Vermutung“ markiert.

## Behoben in 1.1.1

Behoben wurden nur Fehler, die reproduziert sind und deren Korrektur kein Verhalten ändert, das gewollt sein könnte. Regressionstest: `node tests/regression.js` (3 von 5 Tests schlagen gegen 1.1.0 fehl, alle 5 bestehen mit 1.1.1).

1. **Tag-Klick sprang zur Überschrift** (`onLinkClick`). Obsidian rendert Tags als `<a class="tag" href="#tag">`. Der Anker-Handler hielt das für einen Abschnittslink und sprang zu einer Überschrift mit gleichem Namen („#test“ zu „## Test“), statt die Tag-Suche zu öffnen. Jetzt werden Tag-Links übergangen.
2. **Doppelte Überschriften, falsche Anker** (`makeHeadingIndex`). Bei „Beispiel“, „Beispiel“, „Beispiel 1“ vergab das Plugin zweimal `beispiel-1`. GitHub vergibt `beispiel-1` und `beispiel-1-1`. Jetzt zählt es wie github-slugger weiter.
3. **Mehrere `$$`-Formeln in einem `math`-/`latex`-Block** (`stripTexDelimiters`). Aus `$$a$$`, Leerzeile, `$$b$$` wurde `a$$ … $$b`. Die Formel scheiterte, der Block zeigte Quelltext mit Fehlerhinweis. Jetzt wird das äußere Paar nur entfernt, wenn es die ganze Formel umschließt, und jede Teilformel einzeln behandelt.

Die Simulation der beiden Testdateien in allen drei Darstellungen ergibt vor und nach der Änderung dasselbe.

## Funde nach Schwere

Sicherheit: **reproduziert** = selbst ausgeführt; **abgeleitet** = aus dem Code geschlossen; **Vermutung** = hängt von Obsidian-Verhalten ab, das ich nicht prüfen konnte.

### Kritisch

**K1 – `%%` im Text kann Inhalt verschlucken.** Stelle: keine; `main.js` behandelt `%%` nirgends. Auslöser: Test 2, Zeile 7, „Prozent 50 %%“. Obsidian wertet `%%` als Kommentaranfang und blendet Kommentare in der Leseansicht aus. Ohne schließendes `%%` fehlt vermutlich der Rest des Absatzes oder sogar der Datei. Claude zeigt `%%` als Text. Sicherheit: dass das Plugin nichts tut, abgeleitet; die Wirkung in Obsidian ist eine Vermutung. Prüfen: Test 2 öffnen und schauen, ob nach „Prozent 50“ Text fehlt. Nicht behoben: unklar, ob ein Post-Processor das reparieren kann, weil ausgeblendete Abschnitte ihn eventuell gar nicht erreichen.

### Mittel

**M1 – Bearbeiten über Eigenschaften möglich.** Stelle: Leseansicht-Sperre (`enforceReadingView`). Das Plugin sperrt nur den Bearbeitungsmodus. Frontmatter (Test 1) zeigt Obsidian als Eigenschaften. Diese sind in der Leseansicht vermutlich bearbeitbar, ebenso in der Seitenleiste mit den Dateieigenschaften, falls sie geöffnet ist. Beides schreibt in die Datei. Sicherheit: Vermutung, nur in Obsidian prüfbar. Nicht behoben.

**M2 – Checkboxen per Tastatur umschaltbar.** Stelle: `styles.css`, `pointer-events: none`. Das blockiert nur die Maus. Eine Checkbox lässt sich vermutlich mit Tab fokussieren und mit der Leertaste umschalten; das löst dasselbe Klick-Ereignis aus, und Obsidian schreibt die Datei. Sicherheit: Vermutung. Vorschlag: Klicks auf `input.task-list-item-checkbox` im vorhandenen Capture-Handler abfangen. Nicht behoben.

**M3 – Plugin lädt gar nicht, wenn ein anderes Plugin dieselbe Code-Sprache belegt.** Stelle: `onload()`, `registerMarkdownCodeBlockProcessor` für `latex`, `math`, `csv`, `tsv`, `markdown`, `md`. Nach meinem Wissen wirft Obsidian einen Fehler, wenn eine Sprache schon registriert ist. Dann bricht `onload` ab: keine Leseansicht-Sperre, keine Befehle, keine Umbauten. Die README nennt nur zwei Konflikt-Plugins. Sicherheit: Vermutung. Vorschlag: jede Registrierung in `try/catch`. Nicht behoben.

**M4 – Fließtext, der mit `<details>` beginnt, wird zum Klappbereich.** Stelle: `findDetailsRegions`, `DETAILS_OPEN_LINE`. Eine Zeile wie „<details> ist ein HTML-Element …“ und irgendwo später ein `</details>` im Fließtext: Alles dazwischen landet in einem eingeklappten Bereich „Details“, die beiden Tag-Wörter fehlen im Satz. Sicherheit: reproduziert. Nicht behoben, weil eine Verschärfung gewolltes Verhalten ändern kann (siehe Rückfragen).

### Gering

**G1 – Tag-Klick gekapert.** `onLinkClick`. Reproduziert. **Behoben.**

**G2 – Doppelte Slugs.** `makeHeadingIndex`. Reproduziert. **Behoben.**

**G3 – Mehrere `$$`-Formeln in einem Block.** `stripTexDelimiters`. Reproduziert. **Behoben.**

**G4 – `<details>` in einem Listenpunkt zerlegt die Liste.** `detailsBlockToCallout` verwirft die Einrückung. Der Klappbereich landet außerhalb der Liste, die Liste zerfällt in zwei. Ab vier Leerzeichen Einrückung wird `<details>` gar nicht erkannt. Reproduziert. Nicht behoben (größerer Umbau).

**G5 – Zahl mit Punkt am Zeilenanfang gilt als Liste.** `softBreakKind`, `LIST_ITEM_RE`. „Seit“ ⏎ „2024. Jahr …“: Nach CommonMark kann nur eine Liste, die mit 1 beginnt, einen Absatz unterbrechen; das ist also Absatztext. Bei Norm bleiben die Zeilen getrennt statt zusammengezogen. Bei „getrennt“ fehlt der Umbruch, das wirkt nur mit „Strenge Zeilenumbrüche“ an. Reproduziert. Nicht behoben (braucht Listenkontext, Regressionsrisiko).

**G6 – Heuristik für `\(…\)` (nur Chat-Darstellung).** `acceptMath`, `convertMathChunk`. `\(z.B.\)`, `\(Beispiel\)` und `C:\(x86\)` werden zur Formel. `\(x\)2` wird `$x$2`, `\(5\)$` wird `$5$$`. In einer Tabellenzelle wird `\(x|y\)` zu `$x|y$` und zerbricht die Zeile. Reproduziert; wie Obsidian `$x$2` zeigt, ist unbelegt. Nicht behoben.

**G7 – Mehrzeiliges `\[…\]` mit einer Zeile, die wie Liste oder Überschrift beginnt** (`+ b`, `- b`, `=`). Obsidian teilt den Abschnitt, die Umwandlung findet kein Ende, die Formel bleibt roh. Abgeleitet. Nicht behoben.

**G8 – Docs-Erkennung.** `isDocsExport`. Eine Chat-Datei mit „# Titel“, Leerzeile, „Nov 3, 2026“ gilt als Docs-Export (reproduziert). Platzhalter werden nur in maskierter Form `&#91;embedded content` erkannt. Datumszeilen nur mit englischen Monatsnamen. Abhilfe: Ordner-Einstellung oder Augen-Menü. Nicht behoben.

**G9 – Neu dargestellte Abschnitte verlieren Obsidian-Funktionen.** `processSection`. Fußnoten sind dort nur Tooltip ohne Sprung, und der Tooltip zeigt nur die erste Zeile einer mehrzeiligen Fußnote (reproduziert). Der Faltpfeil von Überschriften entfällt (abgeleitet).

**G10 – Obsidian-eigene Syntax bleibt aktiv, auch in „Norm (wie GitHub)“.** Keine Behandlung im Code. `a == b und c == d` zeigt „b und c“ markiert, die Gleichheitszeichen fehlen. `#tag` wird Tag, `[[…]]` Wikilink, `$HOME/$USER` möglicherweise Formel. Wirkung: Vermutung (Obsidian-Verhalten). In Docs-Exporten ist `==markiert==` echte Markierung, deshalb Rückfrage statt Änderung.

**G11 – Docs-Merker kann verfälscht werden.** `isDocsContext`, `analyze`. Falls `getSectionInfo` in verschachtelt gerenderten Inhalten (z. B. Vorschau eines `markdown`-Blocks) nicht `null` liefert, wird der Merker der ganzen Datei aus dem Ausschnitt berechnet und auf `false` gesetzt. Folge: Blöcke in Hover-Vorschau oder Einbettung falsch dargestellt. Vermutung.

**G12 – Aufräumen.** `fileModes` und `pathsWithRegions` werden beim Löschen nie bereinigt; `pathsWithRegions` wandert beim Umbenennen nicht mit. Abgeleitet. Wirkung minimal.

**G13 – Einstellung „Ordner mit Docs-Exporten“.** Speichert und stellt bei jedem Tastendruck alle offenen Dateien neu dar. Der Ordnervergleich unterscheidet Groß- und Kleinschreibung. Abgeleitet.

**G14 – Hinweistext am Diagramm-Platzhalter.** `decorateEmbedPlaceholders` empfiehlt, Claude zu bitten, „das Doc mit Diagrammen als Bilder zu exportieren“. Ob es diesen Weg gibt, ist nicht belegt. Nicht geändert.

**G15 – `<details>` in einem Zitat** (`> <details>`) wird nicht umgebaut. Abgeleitet.

**G16 – Link zu fehlender Datei.** Abgefangen werden nur Klick und Mittelklick. Über das Kontextmenü („In neuem Tab öffnen“) legt Obsidian vermutlich trotzdem eine Notiz an. Vermutung.

**G17 – Umschalten Norm/Claude.** `toggleNorm`: Hat eine Nicht-Docs-Datei bewusst „wie Claude Docs“, kommt sie nach Norm und zurück als „Chat“ wieder. Abgeleitet.

**G18 – Slug mit hochgestellter Ziffer.** `githubSlug("x²")` ergibt `x²`, GitHub `x`. Reproduziert.

**G19 – Canvas.** Die Sperre gilt nur für Markdown-Tabs. Notizkarten in einem Canvas bleiben bearbeitbar. Vermutung.

## Nur in echtem Obsidian prüfbar

- Ob `layout-change` beim Umschalten mit Cmd + E feuert. Sonst greift die Leseansicht-Sperre erst beim nächsten Tab-Wechsel.
- Ob der Sprung zu Überschriften mit `applyScroll(Zeile)` und `setEphemeralState({ line })` an der richtigen Stelle landet.
- Ob Klappbereiche in neu dargestellten Abschnitten klappbar sind.
- Ob `[^1]` ohne Definition im Ausschnitt als Text erscheint (sonst greift der Tooltip nicht).
- Ob MathJax-Fehler als `mjx-merror` erscheinen (davon hängt der Rückfall auf Code ab).
- Ob `&#91;!NOTE\]` im Docs-Export Text bleibt und keine Hinweisbox wird.
- Ob Obsidian asynchrone Post-Processors nacheinander abwartet.
- Ob beim Deaktivieren des Plugins alle Umbauten verschwinden.

## Ohne Befund

- **Dateien:** Das Plugin ruft keine Schreib-Schnittstelle des Vaults auf. Gespeichert wird nur `data.json` im Plugin-Ordner.
- **Bearbeitungsfunktionen:** keine Eingabefelder, kein `contenteditable`; CSV-Tabelle, Markdown-Vorschau und Formelansicht sind reine Anzeige.
- **Obsidian-Schnittstellen:** alle öffentlichen vorhanden (tsc). Einzige inoffizielle: `vault.getConfig('strictLineBreaks')`, abgesichert mit Rückfall.
- **CSV-Parser:** Testdaten korrekt (Anführungszeichen, `""`, Kommas in Feldern, Zahlen rechtsbündig, Semikolon erkannt).
- **Testdateien:** Die simulierten Umbauten entsprechen in allen drei Darstellungen der README-Tabelle.
- **Umbenennen:** Datei-Einstellungen wandern mit, auch bei Ordnern.

## README und Code

Die Tabelle „Zwei Darstellungen“ stimmt mit dem Code überein. Abweichungen:

- „Checkboxen sind nicht anklickbar“: nur für die Maus (M2).
- „Ein Klick auf einen Link zu einer fehlenden Datei legt keine Notiz an“: nur Klick und Mittelklick (G16).
- „Nur ansehen“: Eigenschaften vermutlich bearbeitbar (M1).
- „Norm (Markdown-Standard wie auf GitHub)“: Obsidian-Syntax bleibt aktiv (G10).
- Docs-Erkennung „an Diagramm-Platzhaltern“: nur in maskierter Form (G8).
- Konflikt-Plugins: Code-Sprachen fehlen in der Liste (M3).

## Rückfragen: vielleicht gewollt

1. **`<details>` ist auch in der Chat-Darstellung klappbar,** obwohl die eigene Testdatei sagt, dass der Claude-Chat das nicht tut. Nutzen: besser lesbar; Dateien aus Claude Code werden meist auf GitHub angesehen, wo es klappt. Unverändert gelassen.
2. **`$…$` ist überall Formel** (Obsidian-Verhalten). Ob der Claude-Chat einfache Dollarzeichen setzt, ist nicht belegt.
3. **Obsidian-Syntax entschärfen** (K1, G10): würde Tags, Markierungen und Wikilinks abschalten. Vorschlag: `%%` immer als Text, den Rest nur bei Norm oder per Einstellung.
4. **Strengere `<details>`-Erkennung** (M4): `<details>` muss allein oder mit `<summary>` auf der Zeile stehen. Die jetzige Lockerheit erkennt auch `<details>Inhalt …`.
