import type { ButtonHTMLAttributes, ElementType, HTMLAttributes, ReactNode } from "react";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "tertiary" | "destructive";
  size?: "sm" | "md" | "lg";
}

export function Button(props: ButtonProps): JSX.Element;

export interface HeadingProps extends HTMLAttributes<HTMLElement> {
  as?: ElementType;
  level?: 1 | 2 | 3 | 4 | 5 | 6;
  size?: "xs" | "sm" | "md" | "lg" | "xl";
}

export function Heading(props: HeadingProps): JSX.Element;

export interface TextProps extends HTMLAttributes<HTMLElement> {
  as?: ElementType;
  tone?: "default" | "muted" | "danger" | "success" | "warning";
  size?: "xs" | "sm" | "md" | "lg";
}

export function Text(props: TextProps): JSX.Element;

export interface NavItem {
  to: string;
  label: ReactNode;
  badge?: ReactNode;
  badgeTestId?: string;
}

export interface NavProps<T extends NavItem = NavItem> {
  items: T[];
  renderLink: (item: T, className: string, children: ReactNode) => ReactNode;
  ariaLabel?: string;
  className?: string;
}

export function Nav<T extends NavItem = NavItem>(props: NavProps<T>): JSX.Element;
