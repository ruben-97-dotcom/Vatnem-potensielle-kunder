// Henter kommunegrensene for regionen fra Kartverkets åpne kommune-API, forenkler dem
// og lagrer dem som public/kommuner.json (brukes av kartet). Kjør: node scripts/lag-kommunegrenser.js
const fs = require('node:fs');
const path = require('node:path');
const { KOMMUNER } = require('../src/config');

// Douglas–Peucker-forenkling av en linje (grader, ~0,0006 ≈ 40–60 m).
function forenkle(punkter, toleranse) {
  if (punkter.length < 3) return punkter;
  const [a, b] = [punkter[0], punkter[punkter.length - 1]];
  let maks = 0, indeks = 0;
  for (let i = 1; i < punkter.length - 1; i++) {
    const [x, y] = punkter[i];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l = Math.hypot(dx, dy);
    // Lukket ring (start = slutt): mål avstanden til startpunktet.
    const d = l < 1e-12 ? Math.hypot(x - a[0], y - a[1]) : Math.abs(dy * x - dx * y + b[0] * a[1] - b[1] * a[0]) / l;
    if (d > maks) { maks = d; indeks = i; }
  }
  if (maks <= toleranse) return [a, b];
  return [...forenkle(punkter.slice(0, indeks + 1), toleranse).slice(0, -1), ...forenkle(punkter.slice(indeks), toleranse)];
}
const rund = (p) => [Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5];
const forenkleRing = (ring) => forenkle(ring, 0.0006).map(rund);
const forenkleGeom = (g) => g.type === 'Polygon'
  ? { type: 'Polygon', coordinates: g.coordinates.map(forenkleRing).filter((r) => r.length >= 4) }
  : { type: 'MultiPolygon', coordinates: g.coordinates.map((poly) => poly.map(forenkleRing).filter((r) => r.length >= 4)).filter((p) => p.length) };

(async () => {
  const features = [];
  for (const k of KOMMUNER) {
    const [info, omrade] = await Promise.all([
      fetch(`https://ws.geonorge.no/kommuneinfo/v1/kommuner/${k.nr}`).then((r) => r.json()),
      fetch(`https://ws.geonorge.no/kommuneinfo/v1/kommuner/${k.nr}/omrade?utkoordsys=4258`).then((r) => r.json()),
    ]);
    const geom = forenkleGeom(omrade.omrade);
    features.push({
      type: 'Feature',
      properties: { nr: k.nr, navn: k.navn, punkt: rund(info.punktIOmrade.coordinates) },
      geometry: geom,
    });
    console.log(k.navn, geom.type, JSON.stringify(geom).length, 'byte');
  }
  const ut = path.join(__dirname, '..', 'public', 'kommuner.json');
  fs.writeFileSync(ut, JSON.stringify({ type: 'FeatureCollection', features }));
  console.log('Lagret', ut, fs.statSync(ut).size, 'byte');
})().catch((e) => { console.error(e); process.exit(1); });
