/**
 * Test environment setup.
 *
 * `@testing-library/jest-dom` adds the DOM matchers; the cleanup keeps one
 * test's mounted tree from leaking into the next.
 */

import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});
