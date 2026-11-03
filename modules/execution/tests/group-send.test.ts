import { describe, expect, test } from "bun:test";
import { buildGroupInstructions } from "@openedbot/roster/domain/bot-mode";
import {
  advanceGroupSend,
  coerceGroupDefaultResponder,
  initGroupSend,
  isGroupNudgeTurn,
  parseGroupRouteDecision,
  planRoutineGroupSend,
} from "../src/domain/group-send";

const members = [
  { id: "bot-1", slug: "scout", position: 0 },
  { id: "bot-2", slug: "neo", position: 1 },
];

describe("planRoutineGroupSend", () => {
  test("sans mention, chaque membre répond à tour de rôle, dans l'ordre du salon", () => {
    const planned = planRoutineGroupSend("On fait le point ?", members);
    expect(planned.kind).toBe("open");
    if (planned.kind !== "open") return;
    expect(planned.botId).toBe("bot-1");
    expect(planned.state.phase).toBeUndefined();
    expect(planned.state.queue).toEqual(["bot-2"]);
    expect(planned.state.responders).toEqual(["bot-1", "bot-2"]);
  });

  test("un seul membre est propriétaire sans routeur", () => {
    const planned = planRoutineGroupSend("On fait le point ?", [members[0]!]);
    expect(planned.kind).toBe("open");
    if (planned.kind !== "open") return;
    expect(planned.botId).toBe("bot-1");
    expect(planned.state.phase).toBeUndefined();
    expect(planned.state.queue).toEqual([]);
  });

  test("empty quand le salon n a plus de membre actif", () => {
    expect(planRoutineGroupSend("Il y a quelqu un ?", [])).toEqual({ kind: "empty" });
  });
});

describe("coerceGroupDefaultResponder", () => {
  test("retombe sur everyone si le JSON est illisible", () => {
    expect(coerceGroupDefaultResponder(null, ["bot-1"])).toEqual({ kind: "everyone" });
    expect(coerceGroupDefaultResponder({ kind: "member", botId: "absent" }, ["bot-1"])).toEqual({ kind: "everyone" });
  });

  test("conserve everyone, mentions et un membre du roster", () => {
    expect(coerceGroupDefaultResponder({ kind: "mentions" }, ["bot-1"])).toEqual({ kind: "mentions" });
    expect(coerceGroupDefaultResponder({ kind: "member", botId: "bot-1" }, ["bot-1"])).toEqual({
      kind: "member",
      botId: "bot-1",
    });
  });
});

describe("initGroupSend, réponse à une bulle", () => {
  test("ne réveille que le membre cité, pas tout le roster", () => {
    const opened = initGroupSend("et celle-là ?", members, { kind: "everyone" }, undefined, "bot-2");
    expect(opened?.botId).toBe("bot-2");
    expect(opened?.state.queue).toEqual([]);
    expect(opened?.state.responders).toEqual(["bot-2"]);
  });

  test("une mention dans le texte de la réponse prime sur la cible citée", () => {
    const opened = initGroupSend("@scout regarde", members, { kind: "everyone" }, undefined, "bot-2");
    expect(opened?.state.responders).toEqual(["bot-1"]);
  });
});

describe("advanceGroupSend, relance d un membre adresse", () => {
  const later = {
    round: 2, sent: 1, queue: ["bot-2"], spoke: [] as string[], mentioned: [] as string[],
    responders: ["bot-1"],
  };

  test("un (pass) au premier tour ne relance pas : ce n est pas le scheduler", () => {
    const addressed = initGroupSend("@scout seulement", members)!;
    expect(advanceGroupSend(addressed.state, {
      currentBotId: "bot-1", output: "(pass)", members, explicitPass: true,
    })).toEqual({ kind: "settled" });
  });

  test("un (pass) explicite d un membre deja nomme au tour suivant le relance une fois", () => {
    const first = advanceGroupSend(later, {
      currentBotId: "bot-1", output: null, members, explicitPass: true,
    });
    expect(first).toMatchObject({ kind: "next", botId: "bot-1", nudge: true });
    if (first.kind !== "next") return;
    expect(isGroupNudgeTurn(first.state, "bot-1")).toBe(true);
    const second = advanceGroupSend(first.state, {
      currentBotId: "bot-1", output: null, members, explicitPass: true,
    });
    expect(second).toMatchObject({ kind: "next", botId: "bot-2" });
    expect(second.kind === "next" && second.nudge).toBeFalsy();
  });
});

describe("buildGroupInstructions", () => {
  const input = {
    self: { name: "Scout", slug: "scout", description: null },
    group: { name: "Le crew" },
    members: [{ name: "Scout", slug: "scout", description: null }, { name: "Neo", slug: "neo", description: null }],
    operator: null,
    maxRounds: 3,
  };

  test("un membre adresse repond toujours, les autres tours gardent (pass)", () => {
    const addressed = buildGroupInstructions({ ...input, addressed: true });
    expect(addressed).toContain(
      "look it up with your tools before answering, and put the URLs you actually opened in the message",
    );
    expect(addressed).not.toContain("no network");
    expect(addressed).not.toContain("a few sentences at most");
    expect(buildGroupInstructions(input)).toContain("Otherwise answer exactly `(pass)`");
  });

  test("la consigne web n'apparait que si le toolset web est actif", () => {
    expect(buildGroupInstructions({ ...input, addressed: true })).not.toContain("`web_extract` on the best");
    expect(buildGroupInstructions({ ...input, addressed: true, webToolsEnabled: true })).toContain(
      "`web_search`, then `web_extract` on the best one or two pages",
    );
  });
});

describe("advanceGroupSend, fin de tour", () => {
  const opened = initGroupSend("@everyone yo", members)!;
  const afterFirst = advanceGroupSend(opened.state, { currentBotId: "bot-1", output: "Yo !", members });
  const state = afterFirst.kind === "next" ? afterFirst.state : opened.state;

  test("tout le monde a repondu sans nommer personne : le salon se calme", () => {
    expect(advanceGroupSend(state, { currentBotId: "bot-2", output: "Salut !", members }))
      .toEqual({ kind: "settled" });
  });

  test("seul le membre nomme reprend la parole au tour suivant", () => {
    const next = advanceGroupSend(state, { currentBotId: "bot-2", output: "@scout tu confirmes ?", members });
    expect(next).toMatchObject({ kind: "next", botId: "bot-1", state: { round: 2, queue: [] } });
  });
});

describe("advanceGroupSend, reponse d equipe", () => {
  const trio = [...members, { id: "bot-3", slug: "tank" }];
  const team = { defaultResponder: { kind: "everyone" as const } };

  test("sans mention, aucun routeur : tout le salon répond, le premier membre d'abord", () => {
    const opened = initGroupSend("faites un plan", trio)!;
    expect(opened.botId).toBe("bot-1");
    expect(opened.state.phase).toBeUndefined();
    expect(opened.state.queue).toEqual(["bot-2", "bot-3"]);
    const second = advanceGroupSend(opened.state, { currentBotId: "bot-1", output: "Idée A", members: trio });
    expect(second).toMatchObject({ kind: "next", botId: "bot-2", state: { round: 1, queue: ["bot-3"] } });
    if (second.kind !== "next") return;
    const third = advanceGroupSend(second.state, { currentBotId: "bot-2", output: "Idée B", members: trio });
    expect(third).toMatchObject({ kind: "next", botId: "bot-3", state: { round: 1, queue: [] } });
  });

  test("une reponse sans delegation est deja la reponse", () => {
    const owner = initGroupSend("@scout le plan", trio, { kind: "everyone" }, undefined, null, true)!;
    expect(advanceGroupSend(owner.state, { currentBotId: "bot-1", output: "Idee A", members: trio, team }))
      .toEqual({ kind: "settled" });
  });

  test("une delegation cache les contributions puis le repondant integre", () => {
    const owner = initGroupSend("@scout le plan", trio)!;
    const delegated = advanceGroupSend(owner.state, {
      currentBotId: "bot-1", output: "@neo et @tank, votre partie", members: trio, team,
    });
    expect(delegated).toMatchObject({ kind: "next", botId: "bot-2", state: { phase: "contribution", queue: ["bot-3"] } });
    if (delegated.kind !== "next") return;
    const second = advanceGroupSend(delegated.state, { currentBotId: "bot-2", output: "Partie neo", members: trio, team });
    expect(second).toMatchObject({ kind: "next", botId: "bot-3", state: { phase: "contribution" } });
    if (second.kind !== "next") return;
    const end = advanceGroupSend(second.state, { currentBotId: "bot-3", output: "Partie tank", members: trio, team });
    expect(end).toMatchObject({ kind: "next", botId: "bot-1", state: { phase: "synthesis", queue: [] } });
    if (end.kind !== "next") return;
    expect(advanceGroupSend(end.state, { currentBotId: "bot-1", output: "Plan final", members: trio, team }))
      .toEqual({ kind: "settled" });
  });

  test("une seule contribution deleguee est publiee verbatim", () => {
    const owner = initGroupSend("@scout le plan", trio)!;
    const delegated = advanceGroupSend(owner.state, {
      currentBotId: "bot-1", output: "@neo seulement", members: trio, team,
    });
    if (delegated.kind !== "next") throw new Error("delegation attendue");
    expect(advanceGroupSend(delegated.state, { currentBotId: "bot-2", output: "Idee B", members: trio, team }))
      .toEqual({ kind: "verbatim", botId: "bot-2", text: "Idee B" });
  });

  test("@everyone en mode equipe ne reveille qu un repondant", () => {
    const opened = initGroupSend("@everyone le plan", trio, { kind: "everyone" }, undefined, null, true);
    expect(opened?.botId).toBe("bot-1");
    expect(opened?.state.queue).toEqual([]);
    expect(opened?.state.phase).toBeUndefined();
  });
});

describe("initGroupSend, suite d une conversation adressee", () => {
  const followUp = { previousOperatorText: "@neo quel temps demain ?", lastSpeakerId: "bot-2" };

  test("un message sans mention reste adresse au membre qui vient de repondre", () => {
    expect(initGroupSend("lille", members, { kind: "everyone" }, followUp)?.state.responders).toEqual(["bot-2"]);
  });

  test("une mention, @everyone ou un autre dernier orateur rouvrent le salon", () => {
    expect(initGroupSend("@scout et toi ?", members, { kind: "everyone" }, followUp)?.state.responders).toEqual(["bot-1"]);
    expect(initGroupSend("@everyone lille", members, { kind: "everyone" }, followUp)?.state.responders).toEqual(["bot-1", "bot-2"]);
    expect(initGroupSend("lille", members, { kind: "everyone" }, { ...followUp, lastSpeakerId: "bot-1" })?.state.responders)
      .toEqual(["bot-1", "bot-2"]);
  });
});

describe("parseGroupRouteDecision", () => {
  test("une cle agent, une question, ou idle ; jamais tout le roster", () => {
    expect(parseGroupRouteDecision('{"agentId":"neo"}', members)).toEqual({ kind: "agent", botId: "bot-2" });
    expect(parseGroupRouteDecision('{"question":"Qui ?"}', members)).toEqual({ kind: "question", text: "Qui ?" });
    expect(parseGroupRouteDecision('{"idle":true}', members)).toEqual({ kind: "idle" });
    expect(parseGroupRouteDecision('{"agentId":"all"}', members)).toEqual({ kind: "idle" });
    expect(parseGroupRouteDecision("je reponds moi-meme", members)).toEqual({ kind: "idle" });
  });
});
