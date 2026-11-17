# Claude Markdown Viewer

Obsidian-Plugin für Markdown aus Claude Docs (Markdown-Export), Claude-Chats und Claude Code. Es zeigt jede Datei immer fertig dargestellt: Formeln, Tabellen, Klappbereiche, Bilder. Es gibt keine Umschalter und keine Quelltext-Ansicht; wer den Quelltext sehen will, öffnet die Datei in einem Texteditor. Das Plugin ist ein reiner Viewer: Es liest Dateien nur und schreibt nie in Notizen.

## Installation

1. In Obsidian: Einstellungen → Community-Plugins → Eingeschränkten Modus ausschalten.
2. Den Ordner `claude-markdown-viewer` (mit `main.js`, `manifest.json`, `styles.css`) nach `<Vault>/.obsidian/plugins/` kopieren. Der Ordner `.obsidian` ist im Finder versteckt: Cmd + Shift + Punkt zeigt ihn.
3. Obsidian neu laden (Befehlspalette → „Reload app without saving“) oder neu starten.
4. Einstellungen → Community-Plugins → „Claude Markdown Viewer“ einschalten.

Ein Update geht genauso: die drei Dateien im Ordner ersetzen, Obsidian neu laden.

## Was das Plugin darstellt

Was Obsidian selbst kann (`$…$`, `$$…$$`, Tabellen, Mermaid, Hinweisboxen, Fußnoten, Bilder in Markdown-Syntax, Links), bleibt Obsidians Darstellung. Dazu kommt:

| In der Datei | Darstellung |
| --- | --- |
| Code-Block `latex`, `math` | Formel. Ein ganzes LaTeX-Dokument (`\documentclass` …) kann Obsidian nicht setzen; es bleibt Quelltext mit Hinweis. |
| Code-Block `csv`, `tsv` | Tabelle, Zahlenspalten rechtsbündig |
| Code-Block `markdown`, `md` | dargestelltes Beispiel im Rahmen |
| Code-Block `svg` | Grafik |
| `\(…\)` und `\[…\]` | Formel. Maskierte Klammern wie `\[1\]` oder `\[\[Wikilink\]\]` bleiben Text. |
| `<details>` | Klappbereich mit vollem Markdown, auch mit Leerzeilen, verschachtelt und in Listen. Erkannt, wenn `<details>` allein oder mit `<summary>` auf der Zeile steht. |
| Docs-Export: `\<u>`, `\<sub>`, `\<sup>`, `\<details>` usw. | die Formatierung (unterstrichen, H₂O, x², Klappbereich) statt der maskierten Tags. `\<details>` und `\<summary>` nur, wenn sie wie ein Klappbereich auf der Zeile stehen; mitten im Satz bleiben sie Text. |
| Docs-Export: `> &#91;!NOTE\]` | Hinweisbox |
| Docs-Export: `[embedded content: …]` | Hinweiskasten: Diagramm oder Chart fehlt im Export |
| `%%…%%` | Text statt Obsidian-Kommentar (Claude kennt diese Syntax nicht) |
| `<img src="bilder/a.png">` | Bild; der Pfad wird relativ zur Datei im Vault gesucht |
| `[Text](#github-anker)` | Sprung zur passenden Überschrift, auch in andere Dateien und in Klappbereiche |
| Fußnoten in umgebauten Abschnitten | `[1]` wie bei Obsidian; Tippen springt zur Fußnote |
| Hinweisboxen `> [!IMPORTANT]`, `> [!CAUTION]` | GitHub-Farben (violett, rot) |
| breite Tabellen | horizontal scrollbar |

## Nur ansehen

Eine Einstellung, „Nur ansehen“, voreingestellt an:

- Markdown-Dateien öffnen immer in der Leseansicht. Ein Wechsel in den Bearbeitungsmodus wird sofort zurückgenommen.
- Eigenschaften (Frontmatter) sind sichtbar, aber nicht änderbar, auch nicht per Tastatur.
- Checkboxen lassen sich weder anklicken noch mit der Leertaste umschalten.
- Ein Link zu einer fehlenden Datei legt keine Notiz an, weder per Klick noch über das Kontextmenü.

Zum ausnahmsweisen Bearbeiten in Obsidian die Einstellung ausschalten.

## Grenzen

- Charts und Diagramme aus Claude Docs fehlen schon im Markdown-Export. Das Plugin zeigt dort einen Hinweis.
- Ganze LaTeX-Dokumente lassen sich ohne LaTeX-Programm nicht setzen.
- Klappbereiche, `\(…\)` und maskierte Tags werden nur in der Leseansicht umgebaut, nicht in eingebetteten Notizen (`![[…]]`) und Hover-Vorschauen.
- Ein Docs-Export maskiert Formatierungen und wörtlich getippte Tags gleich. Das Plugin stellt beide als Formatierung dar. Ausnahme: `\<details>` und `\<summary>` mitten im Satz bleiben Text.
- Einfache Zeilenumbrüche regelt Obsidians Einstellung „Strenge Zeilenumbrüche“. Aus (Standard) zeigt Zeilen wie Claude untereinander.
- Belegt ein anderes Plugin die Code-Blöcke `latex`, `math`, `csv`, `tsv`, `markdown`, `md` oder `svg`, meldet das Plugin das beim Start und lässt diese Blöcke aus.
- Ein Link aus einer anderen Datei auf eine Überschrift in einem Klappbereich landet am Anfang des Bereichs.
- `<details>` wird nur erkannt, wenn es höchstens drei Leerzeichen eingerückt ist. In tiefer verschachtelten Listen und in Zitaten (`> <details>`) bleibt es, wie Obsidian es zeigt.
- Eingerückte Code-Blöcke (vier Leerzeichen statt ```` ``` ````) schützt das Plugin nicht: `\(…\)`, maskierte Tags und `%%` werden dort mit umgebaut.
- Nicht zusammen mit „LaTeX Delimiter Renderer“ oder „Details Markdown“ verwenden: beide machen Teile davon und würden doppelt eingreifen.

## Änderungen

**2.0.2**

- Geändert: Maskiertes `\<details>` und `\<summary>` aus Docs-Exporten wird nur noch dargestellt, wenn es wie ein Klappbereich auf der Zeile steht (wie bei unmaskiertem `<details>`). Mitten im Satz bleibt es Text; vorher steckte der Browser den Rest des Absatzes in einen zugeklappten Bereich.
- Geändert: `\[1\]` allein auf einer Zeile bleibt Text (vorher Formel). Gilt für reine Zahlen; `\[1+1\]` bleibt Formel.
- Behoben: Fügt eine Dateiänderung erst einen Klappbereich oder ein `%%`-Paar um vorhandenen Text ein, wird die Datei jetzt ganz neu dargestellt. Vorher konnten Abschnitte doppelt erscheinen, bis die Datei neu geöffnet wurde.
- Absicherung: Inhalt, den das Plugin selbst neu darstellt, wird nicht noch einmal umgebaut.

**2.0.1**

- Behoben: Ein Ankerlink auf eine Überschrift in einem maskierten Klappbereich aus einem Docs-Export (`\<details>`) sprang in den ausgeblendeten Abschnitt.
- Behoben: Fußnoten-Nummern zählten Verweise ohne Definition mit (`[^x]` ohne `[^x]:`); danach stimmten Nummer und Sprungziel nicht.
- Behoben: Code-Block `svg` mit `<!DOCTYPE svg …>` erschien als Code statt als Grafik. Fehlte `xmlns` am `<svg>`-Tag, stand aber weiter innen oder in einem Kommentar davor, blieb das Bild leer.
- Schneller bei großen Dateien ohne Umbau: Der Schnelltest läuft einmal je Datei statt einmal je Abschnitt.

**2.0.0**

- Nur noch eine Darstellung: alles immer fertig dargestellt. Entfernt: „wie Claude Docs“, „wie Claude-Chat“, „Norm“, das Augen-Symbol, die Befehle, die Umschalter an Formel-, CSV- und Markdown-Blöcken und die Docs-Erkennung.
- Neu: maskierte Formatierungen aus Docs-Exporten (`\<u>`, `\<sub>`, `\<sup>`, `\<details>` …) und `> &#91;!NOTE\]` werden dargestellt.
- Neu: `<img>` mit relativem Pfad zeigt das Bild; Code-Block `svg` zeigt die Grafik.
- Entfernt, weil Obsidian es selbst kann oder es Obsidian-Formatierung ist: eigene Zeilenumbruch-Logik, `www.`-Verlinkung, Tags und `==Markierung==` als Text.
- Einstellungen: nur noch „Nur ansehen“ (übernimmt den bisherigen Wert von „Immer Leseansicht“).

**1.2.1**

- Korrigiert: Ein einzelnes `%%` gilt nicht mehr als Kommentar bis zum Dateiende. Die Leseansicht zeigt es als Text (am iPad geprüft); nur der Bearbeitungsmodus färbt den Rest grau. Neutralisiert werden nur noch `%%`-Paare. Der Docs-Export bleibt dadurch unangetastet.
- Fußnoten in umgebauten Abschnitten erscheinen als `[1]` wie bei Obsidian. Tippen springt zur Fußnote am Dateiende oder zeigt ihren Text.
- Text der Einstellung „www.-Adressen verlinken“ korrigiert: Obsidian verlinkt sie inzwischen selbst.

**1.2.0**

- Neu: `%%` erscheint als Text. (Die Annahme, ein einzelnes `%%` blende den Rest der Datei aus, stimmte nur für den Bearbeitungsmodus; siehe 1.2.1.)
- Neu: `#wort` erscheint als Text statt als Obsidian-Tag; `==wort==` bei Chat/Code und Norm als Text. Einstellung „Obsidian-Sonderzeichen als Text“.
- Neu: Eigenschaften sind in der Leseansicht nicht mehr änderbar. Checkboxen reagieren auch nicht mehr auf die Leertaste. Das Kontextmenü eines Links zu einer fehlenden Datei legt keine Notiz mehr an.
- Behoben: Fließtext, der mit `<details>` beginnt, wurde zusammen mit allem bis zum nächsten `</details>` eingeklappt.
- Behoben: `<details>` in einem Listenpunkt zerlegte die Liste.
- Behoben: „Seit“ ⏎ „2024. Jahr“ galt als Liste; bei Norm blieben die Zeilen deshalb getrennt.
- Behoben: Ankerlinks auf Überschriften in Klappbereichen sprangen ins Leere.
- Behoben: Belegte ein anderes Plugin eine Code-Sprache, startete das ganze Plugin nicht.
- Kleinigkeiten: Tooltip zeigt mehrzeilige Fußnoten ganz; Docs-Ordner ohne Rücksicht auf Groß- und Kleinschreibung, gespeichert erst nach einer Tipp-Pause; Anker ohne hochgestellte Ziffern wie bei GitHub; Hinweis am Diagramm-Platzhalter ohne unbelegten Export-Tipp.

**1.1.1**

- Behoben: Ein Klick auf einen Tag (`#tag`) sprang zu einer gleichnamigen Überschrift, statt die Tag-Suche zu öffnen.
- Behoben: GitHub-Anker bei doppelten Überschriften, wenn eine andere Überschrift selbst auf „-1“ endet (z. B. „Beispiel“, „Beispiel“, „Beispiel 1“).
- Behoben: Ein `math`- oder `latex`-Block mit mehreren `$$…$$`-Formeln, durch Leerzeilen getrennt, zeigte nur den Quelltext mit Fehlerhinweis.

**1.1.0**

- Neu: Darstellung „wie Claude“ oder „Norm“, als Standard und je Datei (Augen-Symbol, Befehle).
- Neu: einfache Zeilenumbrüche getrennt oder zusammen, unabhängig von „Strenge Zeilenumbrüche“.
- Neu: Umschalter an `latex`-, `math`-, `csv`- und `tsv`-Blöcken. Im Chat zeigen `latex` und `csv` jetzt zuerst Code, wie im Claude-Chat.
- Entfernt: Befehl „Leseansicht-Sperre ein/aus“ (das Plugin hat keine Bearbeitungsfunktionen mehr). Entfernt: die Einstellungen für `latex`/`math`, `csv` und `\(…\)` einzeln; das regelt jetzt die Darstellung.

**1.0.0**

- Erste Version.
