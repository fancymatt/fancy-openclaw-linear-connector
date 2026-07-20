import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import styles from './Link.module.css';

type LinkVariant = 'default' | 'external' | 'muted';

export interface LinkProps extends ComponentPropsWithoutRef<'a'> {
  /** Visual variant */
  variant?: LinkVariant;
  href: string;
  children?: ReactNode;
}

const externalIcon = (
  <svg
    className={styles.externalIcon}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M7 17L17 7M17 7H7M17 7V17" />
  </svg>
);

export const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link(
  { variant = 'default', href, className, children, ...props },
  ref,
) {
  const classes = [
    styles.link,
    variant === 'muted' && styles.muted,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const isExternal = variant === 'external';

  return (
    <a
      ref={ref}
      href={href}
      className={classes}
      {...(isExternal && { target: '_blank', rel: 'noopener noreferrer' })}
      {...props}
    >
      {children}
      {isExternal && externalIcon}
    </a>
  );
});
