# @fancyfleet/components

React component library for the **Warm Precision Design System**.

*Instruments, not decorations.*

## Installation

```bash
npm install @fancyfleet/components @fancyfleet/tokens
```

## Usage

```tsx
import { Button, Input, Link, Nav, Heading, Text } from '@fancyfleet/components';
import '@fancyfleet/tokens';

function App() {
  return (
    <>
      <Nav
        logo={{ label: 'MyApp', href: '/' }}
        items={[
          { label: 'Dashboard', href: '/dash', active: true },
          { label: 'Settings', href: '/settings' },
        ]}
      />
      <Heading as="h1">Welcome</Heading>
      <Text variant="body">Sign in to your account</Text>
      <Input label="Email" placeholder="you@example.com" />
      <Button variant="primary" size="md">Continue</Button>
      <Link href="/forgot">Forgot password?</Link>
    </>
  );
}
```

## Components

| Component | Variants | Sizes |
|---|---|---|
| `Button` | primary, secondary, ghost, danger | sm, md, lg |
| `Input` | — (label, error, helperText, icon) | — |
| `Link` | default, external, muted | — |
| `Nav` | — (items, logo, actions) | — |
| `Heading` | h1–h6 | — |
| `Text` | body, small, caption | — |

## Design

All components use CSS Modules backed by CSS custom properties from `@fancyfleet/tokens`. No Tailwind, no CSS-in-JS runtime.

Dark mode is automatic via `prefers-color-scheme`.
