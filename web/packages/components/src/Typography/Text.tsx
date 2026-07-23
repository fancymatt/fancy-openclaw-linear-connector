import { type ComponentPropsWithoutRef } from 'react';
import styles from './Typography.module.css';

type TextVariant = 'body' | 'small' | 'caption';

export interface TextProps extends ComponentPropsWithoutRef<'p'> {
  /** Size/content variant */
  variant?: TextVariant;
}

const variantClass: Record<TextVariant, string> = {
  body: styles.body,
  small: styles.small,
  caption: styles.caption,
};

export function Text({ variant = 'body', className, ...props }: TextProps) {
  const classes = [variantClass[variant], className].filter(Boolean).join(' ');
  return <p className={classes} data-ff="text" {...props} />;
}
