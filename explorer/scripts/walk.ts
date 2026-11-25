/**
 * Walks the spec's demo transcript against a running explorer (default http://localhost:5183)
 * and the live API, at desktop and phone sizes, saving screenshots. Run: `npm run demo:walk`.
 * Exits non-zero if a step that must work does not.
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Page } from 'playwright';

const BASE = process.env.EXPLORER_URL ?? 'http://localhost:5183';
const OUT = path.resolve(process.env.SHOTS_DIR ?? '../../shots/explorer');
const VIEWPORTS = [
  { name: '1280x800', width: 1280, height: 800 },
  { name: '390x844', width: 390, height: 844 },
] as const;

const failures: string[] = [];
const notes: string[] = [];

function check(ok: boolean, what: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`);
  if (!ok) failures.push(what);
}

async function shot(page: Page, viewport: string, name: string, fullPage = true): Promise<void> {
  await page.screenshot({ path: path.join(OUT, `${viewport}-${name}.png`), fullPage });
}

async function open(page: Page, section: string): Promise<void> {
  await page.goto(`${BASE}/#/${section}`);
  await page.getByTestId(`section-${section}`).waitFor({ timeout: 20_000 });
}

/** The scroll area is inside the app shell, so grow the viewport to capture a whole section. */
async function fullShot(
  page: Page,
  viewport: (typeof VIEWPORTS)[number],
  name: string,
): Promise<void> {
  const height = await page.evaluate(() => {
    const content = document.getElementById('main');
    const top = document.querySelector('.topbar');
    return (content?.scrollHeight ?? 800) + (top?.getBoundingClientRect().height ?? 0);
  });
  await page.setViewportSize({
    width: viewport.width,
    height: Math.ceil(Math.min(Math.max(height, viewport.height), 9000)),
  });
  await page.waitForTimeout(400);
  await shot(page, viewport.name, name, false);
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
}

async function walk(viewport: (typeof VIEWPORTS)[number], dark: boolean): Promise<void> {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: dark ? 'dark' : 'light',
  });
  const page = await context.newPage();
  const tag = dark ? `${viewport.name}-dark` : viewport.name;
  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('dialog', (d) => {
    failures.push(`native dialog appeared: ${d.message()}`);
    void d.dismiss();
  });

  // 1. Run summary
  await open(page, 'summary');
  await page.getByTestId('latest-run').waitFor({ timeout: 30_000 });
  await page.getByTestId('run-history').waitFor({ timeout: 30_000 });
  await page.getByTestId('limitations-list').waitFor();
  await page.getByTestId('source-list').waitFor();
  await page.getByTestId('permit-coverage-table').waitFor({ timeout: 30_000 });
  notes.push(
    `[${tag}] permit coverage (live): ${(await page.getByTestId('permit-coverage-table').locator('tbody tr').allTextContents()).join(' | ')}`,
  );
  check(
    (await page.getByTestId('header-county').textContent())?.includes('San Diego') ?? false,
    `[${tag}] header shows the county`,
  );
  check(
    (await page.getByTestId('run-history').locator('article').count()) >= 1,
    `[${tag}] run history lists runs`,
  );
  await shot(page, tag, '01-summary', false);
  if (!dark) await fullShot(page, viewport, '01-summary-full');
  if (dark) {
    await browser.close();
    return;
  }

  const summaryPermitTotal =
    (await page.getByTestId('permit-coverage-total').locator('td').first().textContent()) ?? '';

  // 2. Records by source
  await open(page, 'records');
  await page.getByTestId('record-totals').waitFor({ timeout: 30_000 });
  const permitTotal =
    (await page.getByTestId('total-permit').locator('.stat-value').textContent()) ?? '';
  check(
    permitTotal === summaryPermitTotal,
    `[${tag}] permit total agrees across pages: Records ${permitTotal}, Run summary ${summaryPermitTotal}`,
  );
  notes.push(
    `[${tag}] permit secondary line: ${await page
      .getByTestId('permit-source-rows')
      .textContent()
      .catch(() => 'absent')}`,
  );
  await page.getByTestId('source-table').waitFor();
  notes.push(
    `[${tag}] source times: ${(await page.getByTestId('source-table').locator('tbody tr').first().textContent()) ?? ''}`.slice(
      0,
      330,
    ),
  );
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="total-coordinates"] .stat-value')?.textContent !== '…',
    undefined,
    { timeout: 30_000 },
  );
  const coords = await page.getByTestId('total-coordinates').locator('.stat-value').textContent();
  check(/\d/.test(coords ?? ''), `[${tag}] coordinate count is live (${coords})`);
  check(
    ((await page.getByTestId('bbb-note').textContent()) ?? '').length > 20,
    `[${tag}] BBB note is shown`,
  );
  await fullShot(page, viewport, '02-records');

  // 3. Query layer
  await open(page, 'query');
  await page.getByTestId('duckdb-statement').waitFor();
  await page.getByTestId('schema').waitFor({ timeout: 30_000 });
  for (const id of [
    'aged-roofs',
    'long-open-permits',
    'owners-unchanged',
    'out-of-area',
    'top-contractors',
  ]) {
    await page.getByTestId(`sql-example-${id}`).click();
    await page.getByTestId('sql-row-count').waitFor({ timeout: 45_000 });
    const rows = await page.getByTestId('sql-row-count').textContent();
    check(/[1-9]/.test(rows ?? ''), `[${tag}] SQL example ${id} returns rows (${rows})`);
    if (id === 'long-open-permits') await shot(page, tag, '03-query-long-open', false);
  }
  await fullShot(page, viewport, '03-query-full');
  await page.getByTestId('sql-example-forbidden').click();
  await page.getByTestId('sql-rejected').waitFor({ timeout: 30_000 });
  const rejection = (await page.getByTestId('sql-rejected-message').textContent()) ?? '';
  check(/rejected/i.test(rejection), `[${tag}] guard refusal shown: "${rejection}"`);
  await page.getByTestId('sql-rejected').scrollIntoViewIfNeeded();
  await shot(page, tag, '03-query-guard', false);
  await page.getByTestId('sql-example-timeout').click();
  await page
    .waitForFunction(
      () =>
        /time limit/i.test(
          document.querySelector('[data-testid="sql-rejected-kind"]')?.textContent ?? '',
        ),
      undefined,
      { timeout: 60_000 },
    )
    .catch(() => undefined);
  const stopped =
    (await page
      .getByTestId('sql-rejected-message')
      .textContent()
      .catch(() => '')) ?? '';
  check(
    /stopped after 15 seconds/i.test(stopped),
    `[${tag}] runaway query is stopped: "${stopped}"`,
  );
  await page.getByTestId('sql-rejected').scrollIntoViewIfNeeded();
  await shot(page, tag, '03-query-timeout', false);

  // 4. Artifacts
  const errorsBeforeArtifacts = consoleErrors.length;
  await open(page, 'artifacts');
  await page.waitForFunction(
    () =>
      document.querySelector(
        '[data-testid="manifest"], [data-testid="manifest-unpublished"], [data-testid="manifest-error"]',
      ) !== null,
    undefined,
    { timeout: 30_000 },
  );
  await page.waitForFunction(
    () => document.querySelector('[data-testid="publications-loading"]') === null,
    undefined,
    { timeout: 30_000 },
  );
  if ((await page.getByTestId('manifest').count()) > 0) {
    notes.push(
      `[${tag}] manifest is published: root ${await page.getByTestId('manifest-root-cid').textContent()}`,
    );
    const small = page.getByTestId('verify-coverage-json');
    if ((await small.count()) > 0) {
      const clicked = Date.now();
      await small.click();
      // The verdict must not wait for a hanging gateway: time it, then let the slow ones finish.
      await page
        .waitForFunction(
          () =>
            (
              document.querySelector('[data-testid="verify-result-coverage-json-summary"]')
                ?.textContent ?? ''
            ).startsWith('Verified'),
          undefined,
          { timeout: 20_000 },
        )
        .catch(() => undefined);
      const verdictMs = Date.now() - clicked;
      const early =
        (await page.getByTestId('verify-result-coverage-json-summary').textContent()) ?? '';
      check(
        early.startsWith('Verified') && verdictMs < 13_000,
        `[${tag}] verdict shown after ${verdictMs} ms: ${early}`,
      );
      await shot(page, tag, '04-artifacts-verify-partial', false);
      await page
        .locator('[data-testid="verify-result-coverage-json"][data-complete="true"]')
        .waitFor({ timeout: 20_000 });
      const allMs = Date.now() - clicked;
      check(
        allMs < 16_000,
        `[${tag}] every gateway settled within its 12 s budget (${allMs} ms in all)`,
      );
      const rows = page.getByTestId('verify-result-coverage-json').locator('tbody tr');
      for (let i = 0; i < (await rows.count()); i += 1) {
        const row = rows.nth(i);
        notes.push(
          `[${tag}] verify coverage.json ${await row.getAttribute('data-testid')}: ${await row.getAttribute('data-outcome')} ${((await row.textContent()) ?? '').slice(0, 160)}`,
        );
      }
      const summary =
        (await page.getByTestId('verify-result-coverage-json-summary').textContent()) ?? '';
      check(
        summary.startsWith('Verified'),
        `[${tag}] coverage.json verified on 2+ gateways: ${summary}`,
      );
      await page.getByTestId('object-coverage-json').scrollIntoViewIfNeeded();
      for (const g of ['ipfs.raribleuserdata.com', 'ipfs.hypha.coop']) {
        const outcome = await page
          .getByTestId(`verify-result-coverage-json-${g}`)
          .getAttribute('data-outcome');
        check(outcome === 'match', `[${tag}] run 6 root: ${g} passes in-browser (${outcome})`);
      }
      await shot(page, tag, '04-artifacts-verify', false);
    }
    const resolveButtons = page.locator('[data-testid^="check-resolves-"]');
    const publications = await resolveButtons.count();
    check(
      publications >= 2,
      `[${tag}] publication history lists ${publications} runs: ${await page.getByTestId('publication-summary').textContent()}`,
    );
    if (publications >= 2) {
      const earlier = page
        .getByRole('button', { name: 'Check the earlier CID still resolves' })
        .last();
      await earlier.click();
      const summary = page
        .locator('[data-testid^="resolve-result-"][data-testid$="-summary"]')
        .first();
      await page
        .locator('[data-testid^="resolve-result-"][data-complete="true"]')
        .first()
        .waitFor({ timeout: 30_000 });
      const text = (await summary.textContent()) ?? '';
      check(
        text.startsWith('Verified'),
        `[${tag}] earlier root still resolves with the recorded digest: ${text}`,
      );
      notes.push(
        `[${tag}] earlier root basis: ${await page.locator('[data-testid^="resolve-basis-"]').first().textContent()}`,
      );
      for (const g of ['ipfs.raribleuserdata.com', 'ipfs.hypha.coop']) {
        const outcome = await page
          .locator(`[data-testid^="resolve-result-"][data-testid$="-${g}"]`)
          .first()
          .getAttribute('data-outcome');
        check(outcome === 'match', `[${tag}] run 3 root: ${g} passes in-browser (${outcome})`);
      }
      const rows = page.locator('[data-testid^="resolve-result-"] tbody tr');
      for (let i = 0; i < (await rows.count()); i += 1) {
        const row = rows.nth(i);
        notes.push(
          `[${tag}] earlier root ${await row.getAttribute('data-testid')}: ${await row.getAttribute('data-outcome')}`,
        );
      }
      await summary.scrollIntoViewIfNeeded();
      await shot(page, tag, '04-artifacts-history', false);
    }
  } else {
    notes.push(
      `[${tag}] manifest state: ${(await page.getByTestId('card-manifest').textContent())?.slice(0, 160)}`,
    );
  }
  notes.push(
    `[${tag}] publication history: ${((await page.getByTestId('card-publications').textContent()) ?? '').slice(0, 200)}`,
  );
  await fullShot(page, viewport, '04-artifacts-full');

  if ((await page.getByTestId('ipns-resolve').count()) > 0) {
    check(
      /Points at the run being served/.test(
        (await page.getByTestId('ipns-points-at').textContent()) ?? '',
      ),
      `[${tag}] IPNS ${await page.getByTestId('ipns-name').textContent()} points at the served root`,
    );
    await page.getByTestId('ipns-resolve').click();
    await page
      .locator('[data-testid="ipns-result"][data-complete="true"]')
      .waitFor({ timeout: 30_000 });
    const ipnsVerdict = (await page.getByTestId('ipns-result-summary').textContent()) ?? '';
    check(
      ipnsVerdict.startsWith('Verified'),
      `[${tag}] IPNS resolves to the served bytes: ${ipnsVerdict}`,
    );
    await page.getByTestId('card-ipns').scrollIntoViewIfNeeded();
    await shot(page, tag, '04-artifacts-ipns', false);
  } else {
    notes.push(`[${tag}] IPNS card: ${await page.getByTestId('card-ipns').textContent()}`);
  }
  notes.push(
    `[${tag}] CAR rows: ${(await page.locator('[data-testid^="car-"]').allTextContents()).map((t) => t.slice(0, 90)).join(' | ')}`,
  );
  const artifactErrors = consoleErrors.slice(errorsBeforeArtifacts);
  check(
    artifactErrors.length === 0,
    `[${tag}] zero console errors on the artifacts page during verify and the earlier-root check${artifactErrors.length ? `: ${artifactErrors.slice(0, 3).join(' | ')}` : ''}`,
  );
  check(
    (await page.getByTestId('other-gateways').locator('li').count()) === 4,
    `[${tag}] the four other gateways are listed as links only`,
  );

  // 5. Explore map
  await open(page, 'map');
  await page.getByTestId('results-total').waitFor({ timeout: 45_000 });
  await page
    .waitForFunction(
      () =>
        document.querySelector('[data-testid="explore-map"]')?.getAttribute('data-map-ready') ===
        'true',
      undefined,
      { timeout: 30_000 },
    )
    .catch(() => failures.push(`[${tag}] map never became ready`));
  check(
    (await page.getByTestId('results-table').locator('tbody tr[data-testid^="row-"]').count()) > 0,
    `[${tag}] aged-roof rows returned: ${await page.getByTestId('results-total').textContent()}`,
  );
  await page.locator('[data-testid="provenance"]').first().waitFor({ timeout: 30_000 });
  check(
    true,
    `[${tag}] first row shows provenance: ${((await page.locator('[data-testid="provenance"]').first().textContent()) ?? '').slice(0, 120)}`,
  );
  await page.waitForTimeout(2500);
  await shot(page, tag, '05-map-aged', false);
  await fullShot(page, viewport, '05-map-aged-full');

  await page.getByTestId('input-radius').fill('3');
  await page.getByTestId('search-submit').click();
  await page.getByTestId('tab-permits').click();
  await page.getByTestId('results-total').waitFor({ timeout: 45_000 });
  await page.getByTestId('permit-counts').first().waitFor({ timeout: 45_000 });
  check(
    (await page.locator('[data-testid="bbb"]').count()) > 0 ||
      (await page.locator('[data-testid^="permit-"]').count()) > 0,
    `[${tag}] open-permit rows with permit detail: ${await page.getByTestId('results-total').textContent()}`,
  );
  notes.push(
    `[${tag}] coverage note present: ${(await page.getByTestId('coverage-note').count()) > 0}`,
  );
  await page.waitForTimeout(2000);
  await shot(page, tag, '05-map-permits', false);
  await fullShot(page, viewport, '05-map-permits-full');

  for (const [tabId, name] of [
    ['tab-ownership', 'ownership'],
    ['tab-out-of-area', 'out-of-area'],
  ] as const) {
    await page.getByTestId(tabId).click();
    await page.getByTestId('results-loading').waitFor({ state: 'detached', timeout: 45_000 });
    await page.getByTestId('results-total').waitFor({ timeout: 45_000 });
    const total = (await page.getByTestId('results-total').textContent()) ?? '';
    check(
      (await page.getByTestId('results-table').locator('tbody tr[data-testid^="row-"]').count()) >
        0,
      `[${tag}] ${name} tab returns rows: ${total}`,
    );
    if (name === 'ownership') {
      const base = (await page.getByTestId('transfer-base').textContent({ timeout: 30_000 })) ?? '';
      check(
        /This filter can use [\d,]+ of [\d,]+ parcels/.test(base),
        `[${tag}] ownership base stated: ${base}`,
      );
    }
    if (name === 'out-of-area') {
      check(
        /Proxy/.test((await page.getByTestId('out-of-area-note').textContent()) ?? ''),
        `[${tag}] out-of-area proxy note is shown`,
      );
    }
    await page.waitForTimeout(1500);
    await shot(page, tag, `05-map-${name}`, false);
  }

  // A parcel with a pending (applied, not issued) roofing permit, found through the API.
  const pending = await page.evaluate(async () => {
    const response = await fetch('https://mywcppj2yl.execute-api.us-east-2.amazonaws.com/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'queryAtlas',
          arguments: {
            sql: "SELECT p.apn, p.lat, p.lon FROM permit m JOIN parcel p ON p.apn = m.apn WHERE m.is_roofing AND m.status_group = 'pending' ORDER BY m.applied_date DESC LIMIT 1",
          },
        },
      }),
    });
    const body = (await response.json()) as {
      result: { structuredContent: { rows: { apn: string; lat: number; lon: number }[] } };
    };
    return body.result.structuredContent.rows[0] ?? null;
  });
  if (pending) {
    await page.getByTestId('tab-aged').click();
    await page.getByTestId('input-lat').fill(String(pending.lat));
    await page.getByTestId('input-lon').fill(String(pending.lon));
    await page.getByTestId('input-radius').fill('0.1');
    await page.getByTestId('input-min-age').fill('0');
    await page.getByTestId('search-submit').click();
    const row = page.getByTestId(`row-${pending.apn}`);
    const found = await row.waitFor({ timeout: 45_000 }).then(
      () => true,
      () => false,
    );
    if (found) {
      if ((await page.getByTestId(`detail-${pending.apn}`).count()) === 0)
        await page.getByTestId(`expand-${pending.apn}`).click();
      await page.getByTestId(`detail-${pending.apn}`).waitFor({ timeout: 30_000 });
      const shown = await page
        .getByTestId('permit-pending')
        .first()
        .waitFor({ timeout: 15_000 })
        .then(
          () => true,
          () => false,
        );
      check(
        shown,
        `[${tag}] pending permit shown distinctly on APN ${pending.apn}: ${await page.getByTestId('permit-counts').textContent()}`,
      );
      if (shown) await page.getByTestId('permit-pending').first().scrollIntoViewIfNeeded();
      await shot(page, tag, '05-map-pending-permit', false);
    } else {
      notes.push(
        `[${tag}] pending-permit parcel ${pending.apn} was not in the first page of results; not checked`,
      );
    }
    await page.getByTestId('input-radius').fill('1');
    await page.getByTestId('input-min-age').fill('15');
  }

  // Invalid input clears the old rows; a jump clears the error and searches again.
  await page.getByTestId('input-lat').fill('99');
  await page.getByTestId('search-submit').click();
  check(
    (await page.getByTestId('search-form-error').count()) === 1 &&
      (await page.getByTestId('results-stale').count()) === 1 &&
      (await page.getByTestId('results-table').count()) === 0,
    `[${tag}] invalid latitude shows an inline error and clears the old rows`,
  );
  await shot(page, tag, '05-map-invalid-input', false);
  await page.getByTestId('place-el-cajon').click();
  await page.getByTestId('results-total').waitFor({ timeout: 45_000 });
  check(
    (await page.getByTestId('search-form-error').count()) === 0 &&
      (await page.getByTestId('input-lat').inputValue()) === '32.7948' &&
      (await page.getByTestId('results-table').locator('tbody tr[data-testid^="row-"]').count()) >
        0,
    `[${tag}] jump to El Cajon clears the error and shows fresh rows`,
  );
  check(
    (await page.locator('[data-testid^="apn-"]').count()) > 0,
    `[${tag}] APN shown on every row`,
  );

  await page.getByTestId('place-la-jolla').click();
  await page.getByTestId('results-total').waitFor({ timeout: 45_000 });
  check(
    (await page.getByTestId('input-lat').inputValue()) === '32.8328',
    `[${tag}] jump-to place fills the coordinates`,
  );

  // 6. Agent
  await open(page, 'agent');
  await page.getByTestId('agent-place').selectOption('la-jolla');
  await page.getByTestId('agent-example-aged-roofs').click();
  await page.waitForFunction(
    () =>
      document.querySelector(
        '[data-testid="agent-result"], [data-testid="agent-unavailable"], [data-testid="agent-error"]',
      ) !== null,
    undefined,
    { timeout: 120_000 },
  );
  const agentState =
    (await page.getByTestId('agent-result').count()) > 0
      ? 'answered'
      : (await page.getByTestId('agent-unavailable').count()) > 0
        ? 'unavailable (404)'
        : `error: ${await page.getByTestId('agent-error').textContent()}`;
  notes.push(`[${tag}] agent prompt 1: ${agentState}`);
  if (agentState === 'answered') {
    await page.waitForTimeout(2500);
    await fullShot(page, viewport, '06-agent-aged');
    await page.getByTestId('agent-example-open-permits').click();
    await page
      .getByTestId('agent-loading')
      .waitFor({ timeout: 5000 })
      .catch(() => undefined);
    await page.waitForFunction(
      () => document.querySelector('[data-testid="agent-loading"]') === null,
      undefined,
      { timeout: 120_000 },
    );
    notes.push(
      `[${tag}] agent prompt 2: ${(await page.getByTestId('agent-result').count()) > 0 ? 'answered' : 'not answered'}`,
    );
    await page.waitForTimeout(2500);
    notes.push(
      `[${tag}] agent rows heading: ${await page.getByTestId('agent-rows-count').textContent()}`,
    );
    await fullShot(page, viewport, '06-agent-permits');
  } else {
    await shot(page, tag, '06-agent', false);
  }

  // 7. MCP
  await open(page, 'mcp');
  await page.getByTestId('tool-catalogue').waitFor({ timeout: 30_000 });
  notes.push(`[${tag}] tools listed: ${await page.getByTestId('tool-count').textContent()}`);
  await page.getByTestId('tester-call').click();
  await page.getByTestId('tester-result').waitFor({ timeout: 30_000 });
  check(
    ((await page.getByTestId('tester-result').textContent()) ?? '').includes('San Diego County'),
    `[${tag}] tool tester returns dataset info`,
  );
  await shot(page, tag, '07-mcp', false);
  await fullShot(page, viewport, '07-mcp-full');

  // Keyboard: the first Tab lands on the skip link, the nav is reachable.
  await open(page, 'summary');
  await page.reload();
  await page.getByTestId('section-summary').waitFor();
  await page.keyboard.press('Tab');
  check(
    (await page.evaluate(() => document.activeElement?.className)) === 'skip-link',
    `[${tag}] first Tab focuses the skip link`,
  );

  // No horizontal page overflow.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  check(overflow <= 0, `[${tag}] no horizontal page overflow (${overflow}px)`);

  const real = consoleErrors.filter(
    (e) => !/429|ERR_FAILED|CORS|net::|404|status of 5\d\d/.test(e),
  );
  check(
    real.length === 0,
    `[${tag}] no unexpected console errors${real.length ? `: ${real.slice(0, 3).join(' | ')}` : ''}`,
  );
  notes.push(
    `[${tag}] network console errors from gateways or a missing endpoint: ${consoleErrors.length - real.length}`,
  );
  await browser.close();
}

await mkdir(OUT, { recursive: true });
for (const viewport of VIEWPORTS) await walk(viewport, false);
await walk(VIEWPORTS[0], true);
console.log('\nNotes');
for (const n of notes) console.log(`  ${n}`);
console.log(
  `\n${failures.length === 0 ? 'ALL STEPS PASSED' : `${failures.length} FAILED`} · screenshots in ${OUT}`,
);
process.exit(failures.length === 0 ? 0 : 1);
