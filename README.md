# PDF samenvoegen

Een eenvoudige webtool om PDF-bestanden samen te voegen, die werkt zoals de miniatuurzijbalk in **Voorvertoning** (Preview) op de Mac.

- Het **eerste** PDF-bestand dat je opent is de **bron**.
- PDF's die je daarna in de zijbalk sleept (of toevoegt met **Toevoegen**), komen **achteraan** bij.
- Pagina's kun je daarna verslepen, draaien en verwijderen.
- Met **Bewaar** werk je het originele bronbestand bij, net als in Voorvertoning (in Edge en Chrome). Met **Bewaar als…** maak je een nieuw bestand.

Alles gebeurt in je eigen browser. Bestanden worden nergens naartoe geüpload.

## Gebruik

| Wat | Hoe |
| --- | --- |
| Bron openen | Sleep een PDF in het venster, of klik op **Kies een PDF…** |
| Pagina's achteraan toevoegen | Sleep een of meer PDF's in het venster of op het vak onderaan de zijbalk, of klik op **Toevoegen** |
| Pagina's selecteren | Klik; Ctrl/⌘-klik voor losse pagina's; Shift-klik voor een reeks; Ctrl/⌘+A voor alles |
| Volgorde wijzigen | Sleep miniaturen in de zijbalk, of Alt+↑ / Alt+↓ |
| Draaien | De draaiknoppen in de werkbalk |
| Verwijderen | Delete of Backspace, of de knop **Verwijder** |
| Herstellen / opnieuw | Ctrl/⌘+Z en Ctrl/⌘+Shift+Z (of Ctrl+Y) |
| Bewaren in het origineel | **Bewaar** of Ctrl/⌘+S |
| Bewaren als nieuw bestand | **Bewaar als…** of Ctrl/⌘+Shift+S |

Het gekleurde bolletje bij elke miniatuur laat zien uit welk bestand een pagina komt. Onderaan de zijbalk staat welke kleur bij welk bestand hoort.

## Opslaan naar het originele bestand

In **Edge en Chrome** onthoudt de tool welk bestand de bron is. **Bewaar** schrijft het samengevoegde resultaat dan terug naar dat originele bestand. De eerste keer vraagt de browser of de pagina dat bestand mag wijzigen; geef dan toestemming. Die toestemming geldt tot je het tabblad sluit.

- Onder de bestandsnaam staat dan *Bewaar werkt het origineel bij*.
- Pas je de naam bovenaan aan, dan maakt **Bewaar** een nieuw bestand in dezelfde map. Het origineel blijft dan ongemoeid.
- **Bewaar als…** maakt altijd een nieuw bestand. Daarna werk je verder in dat nieuwe bestand.
- Het bestand wordt eerst helemaal gemaakt en pas daarna weggeschreven. Gaat er iets mis, dan blijft het origineel heel.
- Komt de bron uit een plek zonder echt bestand op schijf (bijvoorbeeld rechtstreeks uit een Outlook-bijlage gesleept), dan kies je zelf waar je het bewaart.

**Firefox en Safari** kunnen niet terugschrijven naar een bestand. Daar wordt het resultaat gedownload, met de naam van de bron.

## Op GitHub Pages zetten

De tool bestaat uit deze bestanden:

```
index.html     de pagina
app.js         de werking
app.css        de opmaak
lib/           pdf.js en pdf-lib (zie lib/VERSIES.md)
.nojekyll      zorgt dat GitHub de bestanden ongewijzigd publiceert
README.md      deze uitleg
```

1. Maak op GitHub een nieuwe repository aan (bijvoorbeeld `pdf-samenvoegen`).
2. Upload **alle** bestanden en de map `lib` naar de hoofdmap van de repository. Via de website kan dat door ze naar **Add file → Upload files** te slepen. Het bestand `.nojekyll` is in Windows Verkenner soms verborgen; het is niet strikt nodig.
3. Ga naar **Settings → Pages**.
4. Kies bij **Source** voor **Deploy from a branch**, branch **main**, map **/ (root)**, en klik op **Save**.
5. Na een minuut staat de tool op `https://<gebruikersnaam>.github.io/pdf-samenvoegen/`.

Er is geen build-stap nodig. Lokaal dubbelklikken op `index.html` werkt niet; de tool moet via een webadres (https) worden geopend.

## Veiligheid

- **Niets verlaat de computer.** Er is geen server, geen upload, geen analytics en geen opslag in de browser.
- **Geen externe servers.** pdf.js en pdf-lib staan in de map `lib` op dezelfde website. Ze zijn ongewijzigd overgenomen uit de officiële npm-pakketten en gecontroleerd tegen de hash die npm publiceert (zie `lib/VERSIES.md`).
- **Content-Security-Policy.** De pagina mag alleen code, lettertypen en gegevens van de eigen website laden en geen verbinding maken met andere servers. GitHub Pages kan geen beveiligingsheaders meesturen, dus de regels staan in een meta-tag. Die geldt voor de pagina zelf, niet voor de achtergrondworker van pdf.js; dat is ongewijzigde code van Mozilla, van deze eigen website.
- **Scripts in PDF's worden niet uitgevoerd.** pdf.js tekent alleen de pagina's. Het onderdeel om PDF-scripts uit te voeren is bewust niet meegeleverd.
- **Scripts gaan er bij het bewaren uit.** JavaScript, het starten van programma's, het versturen van formulieren en andere actieve onderdelen worden uit het resultaat verwijderd. Gewone links naar een webadres of naar een pagina blijven werken. Zit er een script vast aan een link, dan gaat de hele link eruit.
- **Niet binnen een andere website.** Wordt de tool in een frame van een andere website getoond, dan weigert hij te werken en biedt hij aan om zichzelf in een eigen venster te openen (tegen clickjacking).
- **Grote bestanden.** Boven 150 MB vraagt de tool eerst of je het bestand echt wilt openen. Een kwaadaardig ingepakte PDF kan het tabblad nog steeds laten vastlopen; dan sluit je het tabblad.

## Techniek

- [pdf.js](https://mozilla.github.io/pdf.js/) 6.5.438 voor de miniaturen en de paginaweergave.
- [pdf-lib](https://pdf-lib.js.org/) 1.17.1 om de pagina's samen te voegen.
- pdf.js 6 gebruikt nieuwe browserfuncties: gebruik een actuele versie van Edge, Chrome, Firefox of Safari.

## Beperkingen

- Beveiligde (versleutelde) of met een wachtwoord beschermde PDF's kunnen niet worden samengevoegd. Haal eerst de beveiliging eraf.
- Bladwijzers (inhoudsopgave) en invulbare formuliervelden blijven niet behouden in het samengevoegde bestand.
- Titel, auteur en onderwerp van het bronbestand worden overgenomen.
- Op een smal scherm (telefoon) zie je alleen het miniatuuroverzicht; slepen van pagina's werkt daar niet met aanraken.
- Bijlagen die in een PDF zijn ingesloten (paperclip-annotaties) gaan wel mee naar het resultaat.
- Sommige Aziatische tekst kan in de voorvertoning verkeerd worden getoond. In het samengevoegde bestand is die tekst gewoon goed.
