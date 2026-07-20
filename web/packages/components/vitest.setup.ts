import '@testing-library/jest-dom/vitest';

// Ensure React.act is available in jsdom/vitest ESM-CJS bridge (React 19 interop)
// https://github.com/testing-library/react-testing-library/issues/1267
import * as React from 'react';
(globalThis as any).React = React;
