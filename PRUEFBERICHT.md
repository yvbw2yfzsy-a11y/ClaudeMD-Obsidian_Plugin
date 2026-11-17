# Prüfbericht: Claude Markdown Viewer 1.1.0

Geprüft wurden `main.js`, `styles.css`, `manifest.json` und `README.md` aus `claude-markdown-viewer-1.1.0.zip` sowie die drei Testdateien. Eine Anleitung, ein Prüfbericht oder die ursprüngliche Anfrage lagen nicht bei und sind deshalb nicht geprüft. Behauptungen in README und Code-Kommentaren wurden als Behauptungen behandelt.

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
