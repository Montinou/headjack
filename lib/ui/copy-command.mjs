// Copy button text (spec Appendix A): the accessible name must start with the visible label (WCAG 2.5.3).

/**
 * @param {string} [label]
 * @returns {{ visible: string; name: string | undefined }}
 */
export function copyButtonText(label) {
  if (!label) return { visible: "Copy command", name: undefined };
  return { visible: "Copy", name: `Copy ${label} command` };
}
