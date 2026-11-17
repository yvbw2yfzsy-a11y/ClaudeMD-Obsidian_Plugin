# Claude Markdown Viewer

Obsidian-Plugin für Markdown aus Claude Docs (Markdown-Export), Claude-Chats und Claude Code. Es zeigt jede Datei wahlweise so, wie Claude sie darstellt, oder nach der Norm (Markdown-Standard wie auf GitHub). Es ist ein reiner Viewer: Es liest Dateien nur, schreibt nie in Notizen und hat keine Bearbeitungsfunktionen, auch nicht für Tabellen.

## Installation

1. In Obsidian: Einstellungen → Community-Erweiterungen (Community plugins) → Eingeschränkten Modus ausschalten.
2. Den Ordner `claude-markdown-viewer` (mit `main.js`, `manifest.json`, `styles.css`) nach `<Vault>/.obsidian/plugins/` kopieren. Der Ordner `.obsidian` ist im Finder versteckt: Cmd + Shift + Punkt zeigt ihn.
3. Obsidian neu laden (Befehlspalette → „Reload app without saving“) oder neu starten.
4. Einstellungen → Community-Erweiterungen → „Claude Markdown Viewer“ einschalten.

Ein Update geht genauso: die drei Dateien im Ordner ersetzen, Obsidian neu laden.

## Zwei Darstellungen: wie Claude oder Norm

| Element | Wie Claude: Docs-Export | Wie Claude: Chat und Claude Code | Norm (wie GitHub) |
| --- | --- | --- | --- |
| Code-Block `latex` | Formel | Code | Code |
| Code-Block `math` | Formel | Formel | Formel |
| Code-Block `csv`, `tsv` | Tabelle | Text | Text |
| Code-Block `markdown`, `md` | gerenderte Vorschau | Quelltext | Quelltext |
| `\(…\)` und `\[…\]` | Text (im Export sind das maskierte Klammern) | Formel | Text |
| einfacher Zeilenumbruch ohne Leerzeile | neue Zeile | neue Zeile | Leerzeichen, die Zeilen bilden einen Absatz |

In allen drei Fällen gleich: `$…$` und `$$…$$`, Mermaid-Diagramme, Hinweisboxen, Fußnoten, Tabellen, `<details>` als Klappbereich, harte Zeilenumbrüche (zwei Leerzeichen, `\` oder `<br>` am Zeilenende).

„Wie Claude“ ist voreingestellt. Ob eine Datei ein Docs-Export ist, erkennt das Plugin an der Datumszeile unter dem Titel („Nov 17, 2026 · @Name“) und an Diagramm-Platzhaltern. Zuverlässiger ist ein fester Ordner für Docs-Exporte in den Einstellungen.

So schaltest du um:

- **Alle Dateien:** Einstellungen → Claude Markdown Viewer → „Standard-Darstellung“ und „Einfache Zeilenumbrüche“.
- **Eine Datei:** Augen-Symbol oben rechts in der Datei, oder Befehl „Darstellung dieser Datei wählen …“. Zur Wahl stehen Automatisch, wie Claude Docs, wie Claude-Chat und Claude Code, Norm, und getrennt oder zusammen für die Zeilenumbrüche. Die Wahl steht in den Plugin-Daten, nicht in der Datei, und bleibt beim Umbenennen erhalten.
- **Ein Block:** Umschalter oben rechts am Block (Formel oder Code, Tabelle oder Text) bzw. die Reiter „Vorschau“ und „Quelltext“. Das gilt nur, bis die Datei neu dargestellt wird.

Die Obsidian-Einstellung „Strenge Zeilenumbrüche“ musst du nicht ändern. Das Plugin liest sie und gleicht in der Leseansicht selbst aus.

## Weitere Funktionen, in jeder Darstellung

| Element | Darstellung mit Plugin |
| --- | --- |
| `<details>` | Klappbereich mit vollem Markdown, auch mit Leerzeilen, verschachtelt und in Listen. Erkannt, wenn `<details>` allein oder mit `<summary>` auf der Zeile steht; Fließtext wie „`<details>` ist ein HTML-Element“ bleibt Text. |
| `%%` | Text. In Obsidian beginnt `%%` einen Kommentar; ein einzelnes `%%` (etwa „50 %%“) blendet den ganzen Rest der Datei aus. |
| `#wort` | Text statt Obsidian-Tag (etwa `#include` oder `#ff0000`) |
| `==wort==` | Text bei Chat/Code und Norm; Markierung bei Docs-Exporten |
| `[embedded content: …]` | Hinweiskasten: Diagramm fehlt im Docs-Export |
| `[Text](#github-anker)` | Sprung zur passenden Überschrift, auch in andere Dateien und in Klappbereiche |
| Hinweisboxen `> [!IMPORTANT]`, `> [!CAUTION]` | GitHub-Farben |
| breite Tabellen | horizontal scrollbar |
| `www.`-Adressen | Link, falls Obsidian sie nicht schon selbst verlinkt |

Jede dieser Funktionen lässt sich in den Einstellungen abschalten, `%%`, `#wort` und `==wort==` gemeinsam.

## Nur ansehen

- Markdown-Dateien öffnen immer in der Leseansicht. Ein Wechsel in den Bearbeitungsmodus wird sofort zurückgenommen. Abschalten geht nur in den Einstellungen; einen Befehl zum Bearbeiten gibt es nicht.
- Eigenschaften (Frontmatter) sind sichtbar, aber nicht änderbar, auch nicht per Tastatur. Links darin und das Ein- und Ausklappen funktionieren.
- Checkboxen lassen sich weder anklicken noch mit der Leertaste umschalten.
- Ein Link zu einer fehlenden Datei legt keine Notiz an, weder per Klick noch über das Kontextmenü. Stattdessen erscheint ein Hinweis.
- CSV-Tabellen und alle anderen Ansichten sind reine Anzeige: kein Bearbeiten, kein Sortieren, kein Speichern.

## Befehle

In der Befehlspalette (Cmd + P), Präfix „Claude Markdown Viewer“:

- Darstellung dieser Datei wählen …
- Diese Datei: Norm oder wie Claude
- Diese Datei: Zeilenumbrüche getrennt oder zusammen
- Alle offenen Dateien neu darstellen

## Grenzen

- Charts und Diagramme aus Claude Docs fehlen schon im Markdown-Export. Das Plugin zeigt dort einen Hinweis.
- Klappbereiche, `\(…\)` und Zeilenumbrüche werden nur in der Leseansicht umgebaut, nicht in eingebetteten Notizen (`![[…]]`) und Hover-Vorschauen. Dort gilt die Obsidian-Einstellung „Strenge Zeilenumbrüche“.
- Wie Claude im Chat einfache Zeilenumbrüche sowie `latex`- und `csv`-Blöcke zeigt, ist nicht dokumentiert. Die Voreinstellung beruht auf Beobachtung, deshalb ist alles umschaltbar.
- Nicht zusammen mit „LaTeX Delimiter Renderer“ oder „Details Markdown“ verwenden: beide machen Teile davon und würden doppelt eingreifen.
- Belegt ein anderes Plugin die Code-Blöcke `latex`, `math`, `csv`, `tsv`, `markdown` oder `md`, meldet das Plugin das beim Start und lässt diese Blöcke aus. Der Rest funktioniert weiter.
- Ein Docs-Export maskiert Text, den Claude Docs wörtlich zeigt, etwa `\<u>…\</u>` oder `&#91;!NOTE\]`. Das Plugin zeigt ihn deshalb ebenfalls als Text.
- Ein Klappbereich oder ein `%%`-Bereich wird als ein Stück dargestellt. Ein Link aus einer anderen Datei auf eine Überschrift darin landet am Anfang des Bereichs, nicht genau bei der Überschrift.

## Änderungen

**1.2.0**

- Neu: `%%` erscheint als Text. Ein einzelnes `%%` blendete bisher den ganzen Rest der Datei als Obsidian-Kommentar aus (im Docs-Test ab „Prozent 50“).
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
