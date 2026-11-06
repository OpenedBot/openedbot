// Resident memory of a process tree, from `ps` (macOS and Linux).


export function processTreeRssKb(rootPid: number): { rssKb: number; processes: number } {
  const out = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,rss="]).stdout.toString();
  const rows = out.trim().split("\n").map((line) => line.trim().split(/\s+/u).map(Number) as [number, number, number]);
  const children = new Map<number, number[]>();
  for (const [pid, ppid] of rows) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  const rss = new Map(rows.map(([pid, , kb]) => [pid, kb]));
  const seen = new Set<number>();
  const stack = [rootPid];
  while (stack.length) {
    const pid = stack.pop()!;
    if (seen.has(pid) || !rss.has(pid)) continue;
    seen.add(pid);
    stack.push(...(children.get(pid) ?? []));
  }
  return { rssKb: [...seen].reduce((sum, pid) => sum + (rss.get(pid) ?? 0), 0), processes: seen.size };
}

/** Chromium launched by Playwright: the child of this process whose command names the profile. */
export function chromiumPidFor(profileDir: string): number | null {
  const out = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,command="]).stdout.toString();
  for (const line of out.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
    if (match && Number(match[2]) === process.pid && match[3]!.includes(profileDir)) return Number(match[1]);
  }
  return null;
}
