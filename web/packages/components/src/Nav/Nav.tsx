import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import styles from './Nav.module.css';

export interface NavItem {
  label: string;
  href: string;
  active?: boolean;
}

export interface NavProps extends Omit<ComponentPropsWithoutRef<'nav'>, 'children'> {
  /** Navigation items (use when Nav renders its own items) */
  items?: NavItem[];
  /** Logo configuration */
  logo?: { label: string; href: string };
  /** Right-aligned actions area */
  actions?: ReactNode;
  /** When provided, renders children instead of items (for router-aware navs) */
  children?: ReactNode;
}

export function Nav({ items, logo, actions, children, className, ...props }: NavProps) {
  const navClasses = [styles.nav, className].filter(Boolean).join(' ');

  return (
    <nav className={navClasses} data-ff="nav" {...props}>
      {logo && (
        <a href={logo.href} className={styles.logo}>
          {logo.label}
        </a>
      )}
      {children ? (
        <div className={styles.items}>
          {children}
        </div>
      ) : (
        <div className={styles.items}>
          {items?.map((item) => {
            const itemClasses = [styles.item, item.active && styles.active]
              .filter(Boolean)
              .join(' ');
            return (
              <a key={item.href} href={item.href} className={itemClasses}>
                {item.label}
              </a>
            );
          })}
        </div>
      )}
      {actions && <div className={styles.actions}>{actions}</div>}
    </nav>
  );
}
