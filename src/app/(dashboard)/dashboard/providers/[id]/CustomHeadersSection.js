"use client";

import { useCallback, useEffect, useState } from "react";
import PropTypes from "prop-types";
import { Card, Button, Input, Select } from "@/shared/components";
import { SENSITIVE_HEADER_NAMES } from "open-sse/config/customHeaders.js";

const MODE_OPTIONS = [
  { value: "static", label: "Fixed value" },
  { value: "random", label: "Random string" },
];

const MAX_LENGTH = 256;

/**
 * Manage this provider's custom request headers.
 *
 * A rule replaces any existing header with the same name (matched
 * case-insensitively), so a rule targeting Authorization or Content-Type
 * overrides what 9router would otherwise send — hence the warning on the
 * sensitive names below. Nothing is blocked; the user's value is still sent.
 *
 * Self-contained: loads and persists via /api/settings so the host page does
 * not need to thread another settings object through its state.
 */
export default function CustomHeadersSection({ providerId }) {
  const [all, setAll] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [mode, setMode] = useState("static");
  const [value, setValue] = useState("");
  const [length, setLength] = useState("16");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      const data = res.ok ? await res.json() : {};
      setAll(data.customHeaders || {});
    } catch {
      setAll({});
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, providerId]);

  const rules = all[providerId] || [];

  const persist = async (next) => {
    const updated = { ...all };
    if (next.length) updated[providerId] = next;
    else delete updated[providerId];

    // Optimistic: reflect the change immediately, roll back on failure.
    const previous = all;
    setAll(updated);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customHeaders: updated }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "Save failed");
      await load();
    } catch (e) {
      setAll(previous);
      setError(e?.message || "Save failed");
    }
  };

  const add = async () => {
    setError("");
    const trimmed = name.trim();
    if (!trimmed) return setError("Header name is required");
    if (rules.some((r) => r.name.toLowerCase() === trimmed.toLowerCase())) {
      return setError("A rule with this name already exists");
    }

    let rule;
    if (mode === "static") {
      if (!value) return setError("Value is required");
      rule = { name: trimmed, mode: "static", value };
    } else {
      const n = Number(length);
      if (!Number.isFinite(n) || n < 1 || n > MAX_LENGTH) {
        return setError(`Length must be between 1 and ${MAX_LENGTH}`);
      }
      rule = { name: trimmed, mode: "random", length: Math.floor(n) };
    }

    await persist([...rules, rule]);
    setName("");
    setValue("");
  };

  const remove = async (index) => {
    setError("");
    await persist(rules.filter((_, i) => i !== index));
  };

  if (loading) return null;

  return (
    <Card>
      <div className="mb-4">
        <h2 className="text-lg font-semibold">Custom Request Headers</h2>
        <p className="text-sm text-text-muted">
          Extra headers sent to this provider. A rule replaces any existing
          header with the same name. Random values are regenerated for each
          request.
        </p>
      </div>

      {rules.length > 0 && (
        <ul className="mb-4 space-y-2">
          {rules.map((rule, index) => {
            const sensitive = SENSITIVE_HEADER_NAMES.includes(rule.name.toLowerCase());
            return (
              <li
                key={`${rule.name}-${index}`}
                className="rounded-lg border border-border p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <span className="font-mono text-sm">{rule.name}</span>
                    <span className="ml-2 text-xs text-text-muted">
                      {rule.mode === "static"
                        ? `fixed: ${rule.value}`
                        : `random: ${rule.length} chars`}
                    </span>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="delete"
                    onClick={() => remove(index)}
                  >
                    Remove
                  </Button>
                </div>
                {sensitive && (
                  <p className="mt-2 text-xs text-yellow-700 dark:text-yellow-300">
                    This replaces the value 9router normally sends. A wrong
                    value will cause upstream 401 errors.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="X-Session-Id"
          className="font-mono text-xs"
        />
        <Select
          value={mode}
          onChange={(e) => setMode(e.target.value)}
          options={MODE_OPTIONS}
        />
        {mode === "static" ? (
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="value"
            className="font-mono text-xs"
          />
        ) : (
          <Input
            value={length}
            onChange={(e) => setLength(e.target.value)}
            placeholder="length"
            type="number"
            min="1"
            max={MAX_LENGTH}
            className="font-mono text-xs"
          />
        )}
        <Button icon="add" onClick={add} className="w-full">
          Add
        </Button>
      </div>

      {error && (
        <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>
      )}

      <p className="mt-2 text-xs text-text-muted">
        Overriding Authorization, Content-Type, Accept, X-Api-Key or
        Anthropic-Version replaces the value 9router sets — use with care.
      </p>
    </Card>
  );
}

CustomHeadersSection.propTypes = {
  providerId: PropTypes.string.isRequired,
};
