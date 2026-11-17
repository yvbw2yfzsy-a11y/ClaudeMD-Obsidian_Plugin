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
| `<details>` | Klappbereich mit vollem Markdown, auch mit Leerzeilen und verschachtelt |
| `[embedded content: …]` | Hinweiskasten: Diagramm fehlt im Docs-Export |
| `[Text](#github-anker)` | Sprung zur passenden Überschrift, auch in andere Dateien |
| Hinweisboxen `> [!IMPORTANT]`, `> [!CAUTION]` | GitHub-Farben |
| breite Tabellen | horizontal scrollbar |
| `www.`-Adressen | Link |

Jede dieser Funktionen lässt sich in den Einstellungen einzeln abschalten.

## Nur ansehen

- Markdown-Dateien öffnen immer in der Leseansicht. Ein Wechsel in den Bearbeitungsmodus wird sofort zurückgenommen. Abschalten geht nur in den Einstellungen; einen Befehl zum Bearbeiten gibt es nicht.
- Checkboxen sind nicht anklickbar. Ein Klick auf einen Link zu einer fehlenden Datei legt keine Notiz an, sondern zeigt einen Hinweis.
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

## Änderungen

**1.1.0**

- Neu: Darstellung „wie Claude“ oder „Norm“, als Standard und je Datei (Augen-Symbol, Befehle).
- Neu: einfache Zeilenumbrüche getrennt oder zusammen, unabhängig von „Strenge Zeilenumbrüche“.
- Neu: Umschalter an `latex`-, `math`-, `csv`- und `tsv`-Blöcken. Im Chat zeigen `latex` und `csv` jetzt zuerst Code, wie im Claude-Chat.
- Entfernt: Befehl „Leseansicht-Sperre ein/aus“ (das Plugin hat keine Bearbeitungsfunktionen mehr). Entfernt: die Einstellungen für `latex`/`math`, `csv` und `\(…\)` einzeln; das regelt jetzt die Darstellung.

**1.0.0**

- Erste Version.
