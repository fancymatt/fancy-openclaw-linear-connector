# @fancyfleet/tokens

CSS custom property token layer for the **Warm Precision Design System**.

## Usage

```css
@import "@fancyfleet/tokens";
```

Or in HTML:

```html
<link rel="stylesheet" href="node_modules/@fancyfleet/tokens/index.css" />
```

All tokens are defined as CSS custom properties on `:root`. Dark mode is handled automatically via `@media (prefers-color-scheme: dark)`.

## Token Categories

| Category | Example | Count |
|---|---|---|
| Color | `--color-primary`, `--color-bg`, `--color-text` | 18 tokens |
| Typography | `--font-family-heading`, `--font-size-base` | 15 tokens |
| Spacing | `--space-1` (4px) → `--space-12` (96px) | 10 tokens |
| Border Radius | `--radius-sm` → `--radius-full` | 5 tokens |
| Elevation | `--elevation-1` → `--elevation-4` | 4 tokens |
| Transition | `--transition-fast`, `--transition-base` | 2 tokens |
