# Meegeleverde bibliotheken

Deze bestanden komen ongewijzigd uit de officiële npm-pakketten. De pakketten zijn gecontroleerd tegen de integriteitshash die npm publiceert.

| Map | Pakket | Versie | Licentie | npm-integriteit van het pakket |
| --- | --- | --- | --- | --- |
| `pdfjs-dist/` | [pdfjs-dist](https://www.npmjs.com/package/pdfjs-dist) (Mozilla pdf.js) | 6.5.438 | Apache-2.0 | `sha512-vg8Pw1x+AFKy4AMDvhuWl5cOYV8d698UoEANoFFhc79hqXDnZQqnOXoxw3HG907WHOg1JYOvLhP756boddFxpA==` |
| `pdf-lib/` | [pdf-lib](https://www.npmjs.com/package/pdf-lib) | 1.17.1 | MIT | `sha512-V/mpyJAoTsN4cnP31vc0wfNA1+p20evqqnap0KLoRUN0Yk/p3wN52DOEsL4oBFcLdb76hlpKPtzJIgo67j/XLw==` |

## Welke bestanden

- `pdfjs-dist/build/pdf.min.mjs` en `pdf.worker.min.mjs`: weergave van PDF's.
- `pdfjs-dist/standard_fonts/`: standaardlettertypen voor PDF's waarin het lettertype niet is ingesloten.
- `pdfjs-dist/wasm/`: decoders voor JPEG 2000 en JBIG2 (veel gebruikt in scans) en voor kleurbeheer.
- `pdf-lib/dist/pdf-lib.esm.min.js`: samenvoegen en bewaren.

Bewust weggelaten: `quickjs-eval` (scripts in PDF's uitvoeren), de `cmaps` (alleen nodig voor de weergave van sommige Aziatische tekst) en de viewer van pdf.js.

## Bijwerken

1. Kijk op [de beveiligingsmeldingen van pdf.js](https://github.com/mozilla/pdf.js/security/advisories) of er een nieuwe versie nodig is.
2. Download het pakket van `https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-<versie>.tgz` en controleer de hash met `dist.integrity` uit `https://registry.npmjs.org/pdfjs-dist/<versie>`.
3. Vervang dezelfde bestanden als hierboven en werk deze tabel bij.
