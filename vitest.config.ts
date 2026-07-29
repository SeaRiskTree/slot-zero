import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The dataset is 46,553 pair rows and 20,388 wallets; a cold parse is a few seconds.
    testTimeout: 60_000,
    // Nothing in this repo may reach the network. Vitest has no network sandbox, so the
    // guarantee is enforced by test/no-network.test.ts, which greps the sources instead.
  },
});
