import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { create as createTar } from 'tar';

/**
 * The brief's acceptance flow through the real browser UI:
 * signup → organization → dataset → upload → validate → schema → preview → search →
 * new version → compare → publish → another user → API access → audit.
 */
const FIXTURES = path.resolve(import.meta.dirname, '../fixtures/okf');
const run = Date.now().toString(36);
const owner = { name: 'Olivia Owner', email: `owner-${run}@example.com`, password: 'e2e correct horse battery' };
const reader = { name: 'Rafael Reader', email: `reader-${run}@example.com`, password: 'e2e correct horse battery' };
const orgName = `E2E Org ${run}`;
const datasetName = `Northwind ${run}`;
const tmp = mkdtempSync(path.join(os.tmpdir(), 'okf-e2e-'));

async function pack(dir: string, name: string): Promise<string> {
  const out = path.join(tmp, name);
  await createTar({ gzip: true, file: out, cwd: path.dirname(dir) }, [path.basename(dir)]);
  return out;
}

async function signup(page: Page, u: typeof owner) {
  await page.goto('/signup');
  await page.getByLabel('Name').fill(u.name);
  await page.getByLabel('Email').fill(u.email);
  await page.getByLabel('Password').fill(u.password);
  await page.getByRole('button', { name: 'Create account' }).click();
}

test.describe.configure({ mode: 'serial' });

let datasetUrl = '';

test('owner signs up, creates an organization, signs out and back in', async ({ page }) => {
  await signup(page, owner);
  await expect(page).toHaveURL(/\/organizations/);
  await page.getByLabel('Name').fill(orgName);
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page.getByRole('link', { name: new RegExp(orgName) })).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel('Email').fill(owner.email);
  await page.getByLabel('Password').fill(owner.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
});

test('creates a dataset and uploads a valid OKF bundle that the worker validates', async ({ page }) => {
  await loginAs(page, owner);
  await page.goto('/datasets/new');
  await page.getByLabel('Name').fill(datasetName);
  await page.getByLabel('Description').fill('Sales warehouse knowledge for E2E');
  await page.getByLabel('Tags').fill('sales, e2e');
  await page.getByRole('button', { name: 'Create and continue to upload' }).click();

  const archive = await pack(path.join(FIXTURES, 'valid-minimal'), 'valid-minimal.tar.gz');
  await page.getByTestId('bundle-file-input').setInputFiles(archive);
  await expect(page.getByTestId('job-progress')).toBeVisible();
  // The worker picks it up and processing completes; the page then navigates to the dataset.
  await page.waitForURL(/\/datasets\/[0-9a-f-]{36}$/, { timeout: 90_000 });
  datasetUrl = new URL(page.url()).pathname;
  await expect(page.getByTestId('dataset-name')).toHaveText(datasetName);
  await expect(page.getByTestId('status-badge').first()).toHaveText(/Validated/);
  await expect(page.getByText('Concept graph')).toBeVisible();
});

test('shows validation, schema, preview and concept detail', async ({ page }) => {
  await loginAs(page, owner);
  await page.goto(`${datasetUrl}/validation`);
  await expect(page.getByTestId('validation-verdict')).toContainText('conformant');

  await page.getByRole('link', { name: 'Schema', exact: true }).click();
  await expect(page.getByText('Asset schemas')).toBeVisible();
  await expect(page.getByText('order_total')).toBeVisible();
  await expect(page.getByText('NUMERIC(12,2)')).toBeVisible();

  await page.getByRole('link', { name: 'Data Preview' }).click();
  await expect(page.getByTestId('field-stats')).toContainText('owner_team');
  const table = page.getByTestId('concept-table');
  await expect(table.getByRole('link', { name: 'Orders' })).toBeVisible();
  await table.getByRole('link', { name: 'Orders' }).click();
  await expect(page.getByRole('heading', { name: 'Orders' })).toBeVisible();
  await expect(page.getByText('Linked from (3)')).toBeVisible();
  await expect(page.getByRole('link', { name: 'playbooks/late-shipments' })).toBeVisible();
});

test('queries with SQL and finds the dataset in search', async ({ page }) => {
  await loginAs(page, owner);
  await page.goto(`${datasetUrl}/query`);
  await page.getByRole('tab', { name: 'SQL' }).click();
  await page.getByLabel('SQL query').fill("SELECT concept_id, trust_tier FROM concepts WHERE type = 'BigQuery Table' ORDER BY concept_id");
  await page.getByRole('button', { name: /Run/ }).click();
  const results = page.getByTestId('query-results');
  await expect(results).toContainText('tables/orders');
  await expect(results).toContainText('human-reviewed');

  await page.goto(`/search?q=${encodeURIComponent('shipped_at')}`);
  await expect(page.getByTestId('search-results')).toContainText(datasetName);
});

test('uploads a second version, compares versions and publishes', async ({ page }) => {
  await loginAs(page, owner);
  await page.goto(datasetUrl);
  await page.getByRole('button', { name: 'New version' }).click();
  const archive = await pack(path.join(FIXTURES, 'schema-evolution', 'v2'), 'v2.tar.gz');
  await page.getByTestId('bundle-file-input').setInputFiles(archive);
  await expect(page.getByRole('link', { name: 'View validation report' })).toBeVisible({ timeout: 90_000 });
  await page.keyboard.press('Escape');

  await page.goto(`${datasetUrl}/versions/compare?base=1&target=2`);
  await expect(page.getByText('Exact comparison')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Aggregate statistics')).toBeVisible();
  await expect(page.getByText('tables/refunds', { exact: true })).toBeVisible();
  await expect(page.getByText('tables/refunds added')).toBeVisible();

  await page.goto(`${datasetUrl}/sharing`);
  await page.getByRole('button', { name: /Public/ }).click();
  await expect(page.getByRole('button', { name: /Public/ })).toHaveAttribute('aria-pressed', 'true');
  await page.goto(datasetUrl);
  await page.getByTestId('publish-button').click();
  await expect(page.getByTestId('status-badge').first()).toHaveText(/Published/);
});

test('another user can read the published dataset; drafts stay hidden', async ({ page }) => {
  await signup(page, reader);
  await page.goto(datasetUrl);
  await expect(page.getByTestId('dataset-name')).toHaveText(datasetName);
  await expect(page.getByText('Published v2')).toBeVisible();
  await expect(page.getByTestId('publish-button')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New version' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Versions' }).click();
  await expect(page.getByTestId('versions-table').getByRole('link', { name: 'v1' })).toHaveCount(0);
});

test('an API key accesses the dataset and the audit log records it', async ({ page, request }) => {
  await loginAs(page, owner);
  await page.goto('/settings/api-keys');
  await page.getByLabel('Name').fill('e2e');
  await page.getByRole('button', { name: 'Create key' }).click();
  const key = await page.getByTestId('new-api-key').inputValue();
  expect(key).toMatch(/^okf_/);

  const id = datasetUrl.split('/').pop()!;
  const res = await request.get(`/api/v1/datasets/${id}`, { headers: { authorization: `Bearer ${key}` } });
  expect(res.status()).toBe(200);
  expect((await res.json()).name).toBe(datasetName);
  const q = await request.post(`/api/v1/datasets/${id}/query/sql`, { headers: { authorization: `Bearer ${key}` }, data: { sql: 'SELECT count(*) AS n FROM concepts' } });
  expect((await q.json()).rows).toEqual([{ n: '3' }]);

  await page.goto('/settings/audit-log');
  const audit = page.getByTestId('audit-table');
  for (const action of ['api_key.created', 'query.sql', 'dataset.published', 'version.validated', 'dataset.created']) {
    await expect(audit.getByText(action, { exact: true }).first()).toBeVisible();
  }
});

async function loginAs(page: Page, u: typeof owner) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(u.email);
  await page.getByLabel('Password').fill(u.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  // Make the E2E organization the current one (localStorage convenience).
  if (u === owner) await page.evaluate(() => localStorage.removeItem('okf.currentOrg'));
}
