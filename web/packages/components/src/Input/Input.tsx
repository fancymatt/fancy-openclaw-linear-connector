import { forwardRef, useId, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import styles from './Input.module.css';

export interface InputProps extends Omit<ComponentPropsWithoutRef<'input'>, 'size'> {
  /** Label text above the input */
  label?: string;
  /** Error message — when set, the field enters error state */
  error?: string;
  /** Helper text below the input */
  helperText?: string;
  /** Icon element rendered inside the input on the left */
  icon?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, error, helperText, icon, className, id, ...props },
  ref,
) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const hasError = Boolean(error);

  const fieldClasses = [styles.field, hasError && styles.error, className]
    .filter(Boolean)
    .join(' ');

  const inputClasses = [styles.input, icon && styles.inputWithIcon]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={fieldClasses}>
      {label && (
        <label className={styles.label} htmlFor={inputId}>
          {label}
        </label>
      )}
      {icon ? (
        <div className={styles.iconWrap}>
          <span className={styles.icon}>{icon}</span>
          <input ref={ref} id={inputId} className={inputClasses} {...props} />
        </div>
      ) : (
        <input ref={ref} id={inputId} className={inputClasses} {...props} />
      )}
      {hasError && <span className={styles.errorMsg}>{error}</span>}
      {!hasError && helperText && <span className={styles.helper}>{helperText}</span>}
    </div>
  );
});
