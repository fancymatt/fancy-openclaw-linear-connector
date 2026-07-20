import { createElement } from "react";

function cx(...parts) {
  return parts.filter(Boolean).join(" ");
}

export function Button({ variant = "secondary", size = "md", className, ...props }) {
  return createElement("button", {
    ...props,
    className: cx("ff-button", `ff-button-${variant}`, `ff-button-${size}`, className),
  });
}

export function Heading({ as, level = 2, size = "md", className, ...props }) {
  const tag = as ?? `h${level}`;
  return createElement(tag, {
    ...props,
    className: cx("ff-heading", `ff-heading-${size}`, className),
  });
}

export function Text({ as = "p", tone = "default", size = "md", className, ...props }) {
  return createElement(as, {
    ...props,
    className: cx("ff-text", `ff-text-${tone}`, `ff-text-${size}`, className),
  });
}

export function Nav({ items, renderLink, ariaLabel = "Primary navigation", className }) {
  return createElement(
    "nav",
    { "aria-label": ariaLabel, className: cx("ff-nav", className) },
    items.map((item) => {
      const children = [
        createElement("span", { key: "label", className: "ff-nav-label" }, item.label),
        item.badge !== undefined && item.badge !== null
          ? createElement(
              "span",
              {
                key: "badge",
                className: "ff-nav-badge nav-pending-badge",
                "data-testid": item.badgeTestId,
              },
              item.badge,
            )
          : null,
      ];
      return renderLink(item, "ff-nav-link", children);
    }),
  );
}
