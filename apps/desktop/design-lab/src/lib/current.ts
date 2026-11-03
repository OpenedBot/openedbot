import { useEffect, useState } from "react";

/** The template the desktop app is set to use (userData/config.json), via the lab server. */
export function useCurrentTemplate(): [string | null, (name: string) => Promise<string>] {
  const [current, setCurrent] = useState<string | null>(null);
  useEffect(() => {
    void fetch("/__lab/current")
      .then((response) => response.json() as Promise<{ template: string | null }>)
      .then((body) => setCurrent(body.template))
      .catch(() => setCurrent(null));
  }, []);
  const choose = async (name: string): Promise<string> => {
    const response = await fetch("/__lab/choose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const body = (await response.json()) as { template?: string; configPath?: string; error?: string };
    if (!response.ok || !body.template) throw new Error(body.error ?? `HTTP ${response.status}`);
    setCurrent(body.template);
    return body.configPath ?? "";
  };
  return [current, choose];
}
