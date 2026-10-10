import { fmt } from "../ledger/split.js";

export { fmt };

/** "$20" for whole dollars, otherwise "$7.50". */
export function money(cents: number): string {
  return cents % 100 === 0 ? `$${(cents / 100).toLocaleString("en-US")}` : fmt(cents);
}

/** ["Jake","Priya","Sam"] -> "Jake, Priya, and Sam" */
export function listNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}

export function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function titleCase(s: string): string {
  return s
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
