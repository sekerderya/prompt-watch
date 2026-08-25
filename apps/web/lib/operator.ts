const STORAGE_KEY = "pw_operator";

/**
 * The name recorded next to a release.
 *
 * PromptWatch authenticates with one shared secret (ADR-4), so there is no
 * identity to read — every operator is the same principal. This is a name the
 * browser remembers and sends along, which is attribution rather than
 * authentication, and the UI says so where it asks (ADR-13).
 *
 * It is still worth having: "who rolled this back at 3am" is a question teams
 * need answered far more often than they need it proven.
 */
export function getOperator(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Private browsing modes can throw on access; an unnamed release is fine.
    return null;
  }
}

export function setOperator(name: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, name.trim());
  } catch {
    /* nothing to do; the release just goes unattributed */
  }
}

/**
 * Asks once, then remembers. Returns null if the operator declines, which is
 * allowed — refusing to name yourself must not block a rollback.
 */
export function promptForOperator(): string | null {
  const existing = getOperator();
  if (existing) return existing;

  const entered = window.prompt(
    "Your name, recorded next to this release.\n\n" +
      "This is a label, not a login — PromptWatch uses one shared key, so it " +
      "cannot verify who you are. Leave it blank to stay unattributed."
  );
  if (entered === null) return null;

  const trimmed = entered.trim();
  if (trimmed === "") return null;

  setOperator(trimmed);
  return trimmed;
}
