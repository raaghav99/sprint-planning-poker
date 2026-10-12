// Playwright config for the UAT environment (runs against the deployed UAT worker, never production).
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
    testDir: './specs',
    timeout: 240_000,
    expect: { timeout: 15_000 },
    workers: 1,               // sequential: the app limits room creation to 10 per minute per IP
    fullyParallel: false,
    reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
    outputDir: 'test-results',
    use: {
        channel: 'chrome',      // use the installed Chrome, no browser download needed
        headless: true,
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure'
    }
});
