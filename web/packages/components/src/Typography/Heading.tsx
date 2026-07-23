import { type ComponentPropsWithoutRef } from 'react';
import styles from './Typography.module.css';

type HeadingLevel = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';

export interface HeadingProps extends ComponentPropsWithoutRef<'h1'> {
  /** Heading level — renders the corresponding h1–h6 element */
  as?: HeadingLevel;
}

const levelClass: Record<HeadingLevel, string> = {
  h1: styles.h1,
  h2: styles.h2,
  h3: styles.h3,
  h4: styles.h4,
  h5: styles.h5,
  h6: styles.h6,
};

export function Heading({ as: Tag = 'h2', className, ...props }: HeadingProps) {
  const classes = [styles.heading, levelClass[Tag], className].filter(Boolean).join(' ');
  return <Tag className={classes} data-ff="heading" {...props} />;
}
