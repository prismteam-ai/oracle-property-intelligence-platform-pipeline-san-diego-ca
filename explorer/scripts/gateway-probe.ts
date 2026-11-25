/**
 * Asks a real browser, from the explorer's own origin, which public gateways let a page read
 * bytes (CORS). Uses a long-lived public CID so it works before any publish of ours exists.
 * Run: `npm run demo:gateways` with the dev server up.
 */
import { chromium } from 'playwright';

const BASE = process.env.EXPLORER_URL ?? 'http://localhost:5183';
const PATH = process.env.PROBE_PATH ?? 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG/readme';
const GATEWAYS = ['4everland.io', 'storry.tv', 'latam.orbitor.dev', 'ipfs.io', 'dweb.link'];

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(BASE);
const results = await page.evaluate(
  async ({ gateways, path }) => {
    const out: string[] = [];
    for (const g of gateways) {
      const url = `https://${g}/ipfs/${path}`;
      const started = performance.now();
      try {
        const response = await fetch(url, {
          cache: 'no-store',
          signal: AbortSignal.timeout(40_000),
        });
        const bytes = new Uint8Array(await response.arrayBuffer());
        const hash = await crypto.subtle.digest('SHA-256', bytes);
        const hex = Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join(
          '',
        );
        out.push(
          `${g}: readable (CORS ok), HTTP ${response.status}, ${bytes.length} bytes, sha256 ${hex.slice(0, 16)}, ${Math.round(performance.now() - started)} ms`,
        );
      } catch (error) {
        let opaque = 'unreachable';
        try {
          await fetch(url, { mode: 'no-cors', signal: AbortSignal.timeout(20_000) });
          opaque = 'reachable but blocked by CORS';
        } catch {
          // stays unreachable
        }
        out.push(`${g}: ${opaque} (${error instanceof Error ? error.message : 'error'})`);
      }
    }
    return out;
  },
  { gateways: GATEWAYS, path: PATH },
);
for (const line of results) console.log(line);
await browser.close();
