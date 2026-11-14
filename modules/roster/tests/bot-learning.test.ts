import { describe, expect, test } from "bun:test";
import {
  buildLearnInput,
  buildLearningBlock,
  isLearnRequest,
  runtimeCanLearn,
} from "../src/domain/bot-learning";

describe("runtimeCanLearn", () => {
  test("ne s'active que si l'hôte annonce `skills` actif", () => {
    expect(runtimeCanLearn(null)).toBe(false);
    expect(runtimeCanLearn([])).toBe(false);
    expect(runtimeCanLearn([{ name: "skills", enabled: false }])).toBe(false);
    expect(runtimeCanLearn([{ name: "web", enabled: true }, { name: "skills", enabled: true }])).toBe(true);
  });
});

describe("isLearnRequest", () => {
  test("reconnaît une demande d'acquisition, en français et en anglais", () => {
    for (const input of [
      "apprend le framework symfony",
      "Apprends la compétence de développeur Symfony senior",
      "  étudie Doctrine ORM",
      "deviens expert en GEO",
      "learn the Symfony framework",
      "master Twig templating",
      "/learn https://symfony.com/doc/current/index.html",
    ]) {
      expect(isLearnRequest(input)).toBe(true);
    }
  });

  test("ne confond pas « enseigne-moi » ni une phrase qui cite le verbe plus loin", () => {
    for (const input of [
      "apprends-moi Symfony",
      "apprends moi les bases",
      "learn me the basics",
      "Retiens que je déploie le vendredi",
      "Je veux que tu apprennes plus tard",
      "Liste les trois vérifications GEO",
    ]) {
      expect(isLearnRequest(input)).toBe(false);
    }
  });
});

describe("buildLearnInput", () => {
  test("cite la demande, nomme le sujet et impose la preuve par skill_view", () => {
    const input = buildLearnInput("apprend le framework symfony");
    expect(input).toContain('"apprend le framework symfony"');
    expect(input).toContain('covers "framework symfony"');
    expect(input).toContain("skill_manage");
    expect(input).toContain("skill_view");
    expect(input).toContain("web_search");
  });
});

describe("buildLearningBlock", () => {
  test("mémoire coupée : le savoir-faire va en skill, et rien ne promet de retenir un fait", () => {
    const block = buildLearningBlock();
    expect(block.startsWith("## Learning")).toBe(true);
    expect(block).toContain("Memory is off on this profile");
    expect(block).toContain("skill_manage");
    expect(block).toContain("do NOT just acknowledge");
    // Le régime openedbot est retiré (07-09) : plus personne ne lit une telle ligne.
    expect(block).not.toContain("remember:");
  });

  test("quand memory est actif, oriente les faits vers l'outil runtime", () => {
    const block = buildLearningBlock({ memoryToolEnabled: true });
    expect(block).toContain("runtime `memory` tool");
    // Un échec de l'outil se dit, il ne se replie pas sur une ligne morte.
    expect(block).toContain("say so plainly rather than claiming the fact is kept");
    expect(block).not.toContain("remember:");
    expect(block).toContain("skill_manage");
  });
});
