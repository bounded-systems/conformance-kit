// lib/config — tiny, dependency-free helpers for injecting site values into the
// kit's tools via env vars / CLI args. NOTHING here is site-specific; every value
// has a neutral default and is overridden by the consumer.
import { resolve } from "node:path";

// Read an env var with a fallback. Empty string counts as "set" only if keepEmpty.
export const env = (name, fallback = undefined, { keepEmpty = false } = {}) => {
  const v = process.env[name];
  if (v == null) return fallback;
  if (v === "" && !keepEmpty) return fallback;
  return v;
};

// Parse a comma-separated env var into a trimmed, non-empty string[].
export const envList = (name, fallback = []) => {
  const v = process.env[name];
  if (v == null || v === "") return fallback;
  return v.split(",").map((s) => s.trim()).filter(Boolean);
};

// Parse a numeric env var; fall back if missing/NaN.
export const envNum = (name, fallback) => {
  const v = process.env[name];
  if (v == null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

// Resolve a "dist" / build-output dir from (argv slot, then $DIST, then default),
// absolute against the current working directory.
export const resolveDist = ({ arg, envName = "DIST", fallback = "dist" } = {}) =>
  resolve(arg || process.env[envName] || fallback);

// Positional argv (after `node script.mjs`), excluding --flags.
export const positionals = () => process.argv.slice(2).filter((a) => !a.startsWith("--"));
export const hasFlag = (flag) => process.argv.includes(flag);
